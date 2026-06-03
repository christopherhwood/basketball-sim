import { DT, ARC_R, COURT_L } from "../core/constants.js";
import { dist, clamp, lerp, chance, randn, shotTypeFor, distToSeg } from "../core/math.js";
import { rng } from "../core/rng.js";
import { G, offTeam, defTeam, hoop, logEv } from "../core/state.js";
import { tacFor } from "../tactics/tactics.js";
import { threat } from "./defense.js";
import { attemptShot } from "./resolution.js";
import { beginLiveTransition, beginScoreTransition } from "./transition.js";
import { spotsFor } from "./possession.js";
import { nearestDef, makeProb, contestOf } from "./shot.js";
import { effectiveTendencies, tendenciesOf, tendencyFactor } from "./tendency.js";
import { beginFouled } from "./resolution.js";
import { recordDecision, recordTouch, recordTO } from "./debugTally.js";
import { simTunables } from "./tunables.js";
import type { Snapshot, PlayerView } from "./snapshot.js";
import type { BallDecision, OffBallDecision, OffBallCandidate } from "./intent.js";
import type { Player, Point, Tactics } from "../types.js";

/* Default ball-handling rating: the stronger hand. Force-direction (a later PR)
   will pick the hand the defense forces the handler toward; until then every
   read uses the better hand so behavior stays ~unchanged. */
function handleOf(p: Player): number {
  return Math.max(p.attr.handleLeft, p.attr.handleRight);
}

/* Physical-play helpers for the post. weightTerm rewards mass on a bounded
   scale; heightTerm rewards length. Both feed the post-up physical EDGE. */
function weightTerm(p: Player): number {
  return clamp((p.attr.weight - 220) / 12, -6, 8);
}
function heightTerm(p: Player): number {
  return clamp((p.attr.height - 6.5) * 6, -4, 6);
}

// Post matchup: the backer-down's edge weighs physical leverage (strength, mass,
// length) AND finishing touch over a set defender's physicality + interior D.
// Skill matters — an elite finisher scores over a same-size defender, not just
// over a smaller one.
const POST_FINISH_W = 0.3; // weight on finishing skill in the post offense rating
const POST_DEF_BLOCK_W = 0.12; // weight on the defender's shot-blocking — a rim protector deters backdowns
function postOffenseRating(p: Player): number {
  return p.attr.strength + weightTerm(p) + heightTerm(p) + p.attr.finishing * POST_FINISH_W;
}
function postDefenseRating(d: Player): number {
  // physicality (strength/mass) + interior defense + rim protection (block): a
  // great shot-blocker is harder to score over in the post, not just a banger.
  return d.attr.strength + weightTerm(d) + d.attr.interiorD * 0.4 + d.attr.block * POST_DEF_BLOCK_W;
}

function hoopDepth(pt: Point, h: Point): number {
  return Math.abs(pt.x - h.x);
}

function isPaintEntryTarget(pt: Point, h: Point): boolean {
  return hoopDepth(pt, h) <= PASS_RISK_ENTRY_DEPTH && Math.abs(pt.y - h.y) <= PASS_RISK_ENTRY_WIDTH;
}

export function passRouteRisk(from: Point, to: Point, h: Point): number {
  const d = dist(from, to);
  const lateral = Math.abs(from.y - to.y);
  const fromDepth = hoopDepth(from, h);
  const longRisk = clamp((d - PASS_RISK_LONG_START) / PASS_RISK_LONG_RANGE, 0, 1) * 0.45;
  const crossCourtRisk =
    clamp((lateral - PASS_RISK_LATERAL_START) / PASS_RISK_LATERAL_RANGE, 0, 1) *
    clamp((d - PASS_RISK_LONG_START) / PASS_RISK_LONG_RANGE, 0, 1) *
    0.7;

  let entryRisk = 0;
  if (isPaintEntryTarget(to, h) && fromDepth > PASS_RISK_ENTRY_FROM_DEPTH) {
    entryRisk =
      0.25 +
      clamp((lateral - PASS_RISK_ENTRY_WIDTH) / PASS_RISK_LATERAL_RANGE, 0, 1) * 0.6 +
      clamp((d - 12) / 16, 0, 1) * 0.55;
    if (from.y < PASS_RISK_CORNER_Y || from.y > 50 - PASS_RISK_CORNER_Y) entryRisk += 0.3;
  }

  return clamp(longRisk + crossCourtRisk + entryRisk, 0, 2);
}

export function passSelectionPenalty(from: Player, to: Point, h: Point): number {
  const routeRisk = passRouteRisk(from, to, h);
  const awareness = clamp((from.attr.iq - 45) / 35, 0.2, 1.15);
  const skillComfort = clamp((from.attr.pass - 50) / 40, 0, 1);
  return routeRisk * (0.55 + awareness * 0.85) * (1.05 - skillComfort * 0.25);
}

/* ---------- TURNOVER / STEAL / SHOT-SELECTION TUNING ----------
   Every magnitude below is a named knob so the tuning phase can adjust the
   stat it drives without hunting through the logic. Probabilities here apply
   once per decision window (offenseDecide runs every decideCD ticks) or once
   per pass, so they are small per-event but accumulate over a possession. */

// On-ball turnovers / strips (moves TOV up, STL up). Applied once per decision window.
const ON_BALL_TOV_BASE = 0.0017; // baseline chance the on-ball defender forces a TO this window
const STRIP_PRESSURE_MULT: Record<Tactics["pressure"], number> = {
  tight: 1.5, // full-court/ball pressure forces more turnovers
  normal: 1.0,
  sag: 0.55, // sagging off invites fewer live-ball turnovers
};
const STRIP_STEAL_SLOPE = 1 / 4200; // per point of (defender steal - handler handle)
const STRIP_IQ_SLOPE = 1 / 7000; // per point of (defender iq deficit relative to handler) — low handler iq -> more TOs
const STRIP_DRIVE_MULT = 1.7; // driving into pressure is far more turnover-prone
const ON_BALL_TOV_CAP = 0.02; // ceiling on per-window forced-turnover probability
const STRIP_CLEAN_SHARE = 0.4; // of forced TOs, this fraction are clean steals (credit STL); rest are lost balls

// Bad-pass / handling turnovers on a pass (moves TOV up, some STL up).
const BAD_PASS_BASE = 0.0042; // baseline errant-pass chance
const BAD_PASS_PASS_SLOPE = 1 / 2400; // per point of (70 - passer pass): worse passers throw it away more
const BAD_PASS_RECV_PRESSURE = 0.011; // extra chance when a defender is hard on the receiver
const BAD_PASS_RECV_RADIUS = 4.5; // a defender within this of the receiver pressures the catch
const BAD_PASS_CLAIM_RADIUS = 4.5; // a defender this close to the errant ball claims it (credit STL)
const BAD_PASS_ROUTE_BASE = 0.006; // route-risk chance on bad long/diagonal passes
const BAD_PASS_ROUTE_PASS_SLOPE = 1 / 1400; // per point of (70 - passer pass), scaled by route risk
const BAD_PASS_CAP = 0.075; // ceiling on bad-pass probability
// Whether a recovered errant pass is credited as a STEAL is gated by the
// recovering defender's gambleSteal: gamblers jump the ball (steal), passive
// defenders merely corral the loose ball (turnover, no steal). This routes the
// bad-pass steal channel through gambleSteal so the tendency drives total steals.
const BAD_PASS_STEAL_GAMBLE_PIVOT = 50;
const BAD_PASS_STEAL_GAMBLE_SLOPE = 1 / 90; // per point of (gambleSteal - pivot)
const BAD_PASS_STEAL_BASE = 0.72; // claim->steal chance at neutral gambleSteal

// Passing-lane steal (moves STL up). Modestly raised from the prior values.
const LANE_STEAL_BASE = 0.0125; // was 0.015
const LANE_STEAL_STEAL_SLOPE = 1 / 1600; // per point of (defender steal - 70); was 1/600
const LANE_STEAL_PASS_SLOPE = 1 / 2400; // per point of (passer pass - 70) — reduces the chance
const LANE_STEAL_ROUTE_RISK = 0.012; // route-risk bump for long/diagonal passing lanes
const LANE_STEAL_CAP = 0.045; // was 0.06

// Pass route selection. Good-IQ handlers should not attempt low-percentage
// skip passes and diagonal entry feeds just because the target is open.
const PASS_RISK_LONG_START = 17;
const PASS_RISK_LONG_RANGE = 20;
const PASS_RISK_LATERAL_START = 14;
const PASS_RISK_LATERAL_RANGE = 18;
const PASS_RISK_ENTRY_DEPTH = 13.75;
const PASS_RISK_ENTRY_FROM_DEPTH = 12;
const PASS_RISK_ENTRY_WIDTH = 8;
const PASS_RISK_CORNER_Y = 8;

// Drive-read: speed/handle edge and defender positioning bonuses
const DRIVE_SPEED_SLOPE = 1 / 28; // per point of (handler speed - defender speed)
const DRIVE_HANDLE_SLOPE = 1 / 32; // per point of (handler handle - defender perimD)
const DRIVE_IQ_SLOPE = 1 / 60; // per point of defender iq deficit (vs 70 pivot)
const DRIVE_IQ_PIVOT = 70; // low-iq defenders get driven more
const DRIVE_LAG_BONUS = 0.55; // flat bonus when the on-ball defender is tracking-lagged
const DRIVE_LAG_DIST_THRESHOLD = 3.5; // ft: defender is "lagging" if his target is this far from handler
const DRIVE_TIGHT_HANDLE_FLOOR = 58; // handle threshold below which a tight defender suppresses drives
const DRIVE_TIGHT_BONUS = 0.35; // bonus when the handler can beat a tight defender (handle above floor)
// Small residual nudge to attack OFF a SET pick (commit to the action). Reduced
// from 0.45: the on-ball defender is now PHYSICALLY hung up on the screen body, so
// the real separation — not this bonus — supplies the advantage. Gated on the
// screen actually being SET, not mere proximity.
const DRIVE_SCREEN_BONUS = 1.6; // "attack off the pick" downhill bias on a SET screen
const DRIVE_BASE_DIST_MIN = 6; // handler must be outside this range from the hoop to drive
const DRIVE_CONTINUATION_BONUS = 0.22; // extra drive utility when already mid-drive (keep attacking)

// Open-lane check: no defender in the corridor between handler and rim
const OPEN_LANE_CORRIDOR_WIDTH = 4.5; // ft half-width of the lane corridor
const OPEN_LANE_BONUS = 2.8; // drive-utility bonus when the lane is clear
const OPEN_LANE_MIN_DIST = 8; // only meaningful when handler is this far from the hoop

// Drive-and-kick: when help defense commits to a drive, pass to the open man
const DRIVE_KICK_HELP_DIST = 12; // a help defender must be within this of the driver
const DRIVE_KICK_OPEN_BONUS = 2.4; // pass-utility bonus for the kick-out target
const DRIVE_KICK_MIN_HANDLER_DIST = 14; // handler must be this far in to trigger kick consideration
const DRIVE_KICK_PASS_SLOPE = 1 / 30; // per point of passer pass attribute (above 50) boosts kick
const CATCH_SHOOT_PASS_BONUS = 2.6; // pass-utility bonus for a man left open by a committed helper
const CATCH_SHOOT_SHOOT_BONUS = 2.2; // shoot-utility bump when catching wide-open off a kick-out

// Beaten-to-the-rim finish: once the handler has beaten his man and the lane is
// clear of help, he attacks the basket for a layup instead of settling.
const LAYUP_ATTACK_DIST = 16; // ft from rim within which a beaten/clear-lane drive presses on
const LAYUP_DRIVE_BONUS = 0.6; // keep-attacking bonus while still outside finishing range
const LAYUP_FINISH_BONUS = 0.7; // shoot-utility bump to finish at the rim with no help
const LAYUP_BEATEN_BEHIND = 0.5; // ft: on-ball defender is "beaten" if this far past the ball toward... (goal-side test)
const LAYUP_BEATEN_GAP = 3.5; // ft: or has lost this much contact with the handler
const LAYUP_GO_UP_DIST = 5; // ft from rim: at point-blank a beaten driver goes up with it (no "contained" reset)
const PUTBACK_RANGE = 7; // ft from rim within which a fresh offensive rebound goes back up (matches resolution.ts)
const PUTBACK_SHOOT_BONUS = 1.5; // shoot-utility bump for an immediate putback off an offensive board
const BIG_GIVEUP_HANDLE = 62; // handle below which a stranded perimeter big hands off/kicks instead of iso-driving
const BIG_GIVEUP_DEPTH = 17; // ft from rim beyond which a low-handle big is "stranded out" and gives it back (rolls/flashes inside still finish)
const BIG_DRIVE_SUPPRESS = 0.2; // multiplier on a give-up big's drive utility (kills the perimeter iso)
const HANDOFF_PASS_BONUS = 1.6; // pass-utility bump for a give-up big handing it to a capable handler

// Early-clock patience: contested shots are suppressed when the shot clock is
// full, scaled by (1 - openness). Team pace shifts the bar up (slow) or down
// (fast). Tuned so league pace lands near ~100-105 possessions/game.
const BASE_PATIENCE = 0.78; // balanced-pace suppression at a full shot clock (tuned with the bring-up gate for ~105 poss/game)
const PACE_PATIENCE = 0.25; // fast lowers / slow raises the patience bar
const PATIENCE_OPEN_FLOOR = 0.75; // share of the patience bar that still applies to OPEN looks (lower = open shots fire freely)
const DRIVE_URGENCY = 1.0; // late-clock (urg) additive drive-aggression boost

// Wide-open with the ball: shoot in range, otherwise attack the closeout.
const OPEN_CATCH_CONTEST = 0.12; // nearest defender essentially absent below this contest
const OPEN_CATCH_DRIVE_BONUS = 0.7; // attack a developing closeout rather than reset
const OPEN_CATCH_RESET_PENALTY = 0.6; // discourage passing it back out when wide open

// Post-feed: when a teammate is posting with a position edge, the handler feeds him
const POST_FEED_RANGE = 14; // ft to the hoop: a big this close can be fed
const POST_FEED_EDGE_MIN = 1.5; // minimum physical edge for a feed to be attractive
const POST_FEED_PASS_BONUS = 1.4; // pass-utility bonus when feeding a posting big (scaled by the mismatch size)
const POST_FEED_SMOTHER_R = 5.5; // ft: a 2nd defender this close to the post man means a double-team — don't feed into it
const POST_FEED_TEND_PIVOT = 45; // postUp tendency threshold to be feed-eligible (matches POST_OFFBALL_PIVOT)

// Three-point shot volume (moves 3PA without flattening per-player divergence).
const THREE_UTILITY_MULT = 1.12;
// Controls how strongly the shootThree tendency swings three volume: 1 = full
// (0.5..1.5) swing. Slightly above full keeps explicit three-point coaching
// visible after route-risk tuning removes some easy pass-first outcomes.
// Shoot-tendency → volume coupling: steeper than the generic tendencyFactor so a
// player's shoot tendency (and coaching that shifts it) drives his shot volume
// with teeth. Pivot near the league-average shoot tendency (neutral there); the
// spread widens so a reluctant shooter genuinely defers and a gunner fires more.
const SHOOT_TEND_PIVOT = 55;
const SHOOT_TEND_SLOPE = 0.0145; // per tendency point — slightly steeper than generic ~0.0112
const SHOOT_TEND_LO = 0.55;
const SHOOT_TEND_HI = 1.55;
function shootTendMult(tend: number): number {
  return clamp(1 + (tend - SHOOT_TEND_PIVOT) * SHOOT_TEND_SLOPE, SHOOT_TEND_LO, SHOOT_TEND_HI);
}
// Flat additive bump to open three-point utility. Lifts low-three teams toward
// the 3PA floor WITHOUT scaling up high-volume teams (they are already shooting),
// so it tightens the floor without pushing the pace-and-space ceiling over.
const THREE_UTILITY_FLOOR = 1.5;

// Post-up mechanic (adds close buckets + free throws for bigs). A post threat
// near the basket with a physical edge over his on-ball defender backs him down.
const POST_RANGE = 12; // ft to the hoop within which a post-up is available
const POST_BASE_UTIL = 0.55; // base attraction of a post-up for a posting big with the ball at the block
const POST_MIN_EDGE = 0; // need at least a neutral matchup to back a defender down
const POST_MIN_TEND = 35; // a player only backs his man down if he's enough of a post threat (reluctant guards drive instead)
const POST_EDGE_CAP = 45; // clamp the edge bonus; high enough that a true mismatch (a guard on a big) posts hard, but bounded
const POST_EDGE_UTIL_MULT = 0.05; // converts (capped) physical edge -> extra post-up utility
const POST_TEND_MULT = 1.25; // scales post-up utility by the postUp tendency factor
const POST_EDGE_MULT = 0.012; // make-prob bump per point of physical edge
const POST_EDGE_MAKE_CAP = 0.16; // ceiling on the make-prob bump from the edge
const POST_FOUL_BASE = 0.15; // baseline foul-draw chance on a backdown
const POST_FOUL_EDGE_SLOPE = 0.006; // extra foul-draw chance per point of edge
const POST_FOUL_CAP = 0.36; // ceiling on post-up foul-draw chance
const POST_OFFBALL_PIVOT = 70; // postUp tendency at/above which a DEDICATED post big camps the block off-ball (kept high so stretch bigs space/pop and only post when fed or on a mismatch)

/* ---------- OFF-BALL ROLE + MOTION TUNING ----------
   Role classification and ball-reactive cutting knobs. Bigs operate INSIDE
   (dunker spot / short corner / block); shooters space to the perimeter. */
const BIG_SHOOT_THREE_MAX = 45; // shootThree below this -> treat as an inside (big) role
const BIG_POST_PIVOT = POST_OFFBALL_PIVOT; // high postUp also marks an inside role
// A screening big pops beyond the arc (pick-and-pop) when he can actually shoot
// it — gated on three-point RATING, with even a modest shooting tendency. This is
// what keeps stretch bigs (e.g. a 7-footer with range) from always rolling.
const POP_THREE_RATING = 68; // three rating at/above which a screener can pick-and-pop
const POP_THREE_TEND = 40; // minimum shootThree tendency to bother popping
const POP_OUT_DEPTH = 24.5; // ft from the hoop the screener pops to (beyond the 23.75 arc → a real three)
const POP_SHARE_BASE = 0.4; // base share of PnRs a capable shooter pops (rest he rolls)
const POP_SHARE_SLOPE = 0.012; // per point of shootThree above 50 → more popping

// PnR macro-intent: the designated screener gets a large additive bonus on the
// "screen" candidate so a ball screen is set ~every possession (the coordination a
// set play exists for — pure-neutral utility wouldn't reliably reproduce it). It is
// large enough to clear holdSpace + OFFBALL_NOISE every decision window. A short
// bringup delay (possClock) lets the handler get the ball up the floor before the
// screener comes to set the pick — without it the action fires at possession start
// and inflates pace (legacy had a bringup→screen phase gate that did the same).
const PNR_SCREEN_BONUS = 6.0;
const PNR_BRINGUP_DELAY = 1.6; // seconds into the possession before the screener sets the pick

// Roll-vs-pop UTILITY (replaces the old chance(G.screenPop) rng). After the screen
// is set the screener picks roll (dive to the rim) vs pop (lift beyond the arc) by
// utility: pop is weighted by his three RATING, his shootThree tendency, and whether
// the pop is open; roll is the default for non-shooters. Deterministic — the choice
// is a function of frozen ratings/tendencies/geometry, decided at the commit moment.
const POP_RATING_PIVOT = POP_THREE_RATING; // three rating at which pop interest turns on
const POP_RATING_SLOPE = 0.05; // per point of three rating above the pivot
const POP_TEND_SLOPE = 0.02; // per point of shootThree above the pop tendency floor
const POP_OPEN_BONUS = 0.5; // pop is more attractive when the pop spot is uncontested
const ROLL_BASE_UTIL = 1.0; // baseline roll attraction (the dive is the default action)
// Pocket pass to the rolling screener: the PnR's primary rim read. Feed him when
// his dive is open and he's diving toward the rim (the authentic way drop coverage
// is punished — the on-ball stays home, the big can't be in two places).
const ROLL_FEED_RANGE = 14; // ft from rim within which a rolling screener is a rim feed
const ROLL_FEED_BONUS = 2.0; // pass-utility bonus for a feed to an open roller (×openness)
const POP_OPEN_RADIUS = 6; // ft: a defender within this of the pop spot makes it contested

// Inside home spots (relative to the attacking hoop), assigned to bigs so they
// stop drifting to the arc. Homes are lane-adjacent; block touches are temporary.
const INSIDE_X = 5; // ft from the hoop along the baseline axis for block spots
const INSIDE_SHORT_X = 8.5; // short-corner depth
const DUNKER_X = 4; // dunker-spot depth (rolled-screener reset / lone big)

// Ball-reactive cutting window. The early-clock bonus to off-ball motion fades by
// mid-clock; the off-ball UTILITY weights (below) consume this via `earlyClock`.
const CUT_EARLY_CLOCK_T = 12; // shot-clock seconds above which the early-clock bonus applies fully

// Ball-holder patience: when the handler's best look is a mediocre pass (nobody
// is open) and there's time on the clock, he holds/probes instead of forcing it,
// letting off-ball men cut/relocate and a screener come to him.
const HOLD_GO_THRESHOLD = 1.4; // max(shootU,driveU) below this = no compelling attack → consider holding
const HOLD_PASS_QUALITY = 1.0; // bestPU below this = no real look yet → consider holding
const HOLD_MIN_CLOCK = 9; // never hold once the shot clock is under this (urgency takes over)
const HOLD_MAX_T = 1.0; // cap on cumulative hold/probe time per possession (short beat of motion, then take the best look)
const HOLD_RESET_CLOCK_HI = 15; // a guard/playmaker resets (dribbles back out) inside this shot-clock window
const HOLD_RESET_CLOCK_LO = 11;
const HOLD_CUT_CHANCE = 0.05; // per-decision chance a weak-side man makes a basket cut during a hold
const CUTOFF_AHEAD = 5.5; // ft ahead of the driver a defender must be to cut off the drive
const CUTOFF_WIDTH = 3.0; // ft lateral half-width of the driving lane for a cutoff
// On-ball cutoff is a matchup roll: defender containment (perimD/speed/iq) vs
// handler attack (handle/speed/iq). Base ~0.5 (even matchup contained half the
// time); an elite handler vs a poor defender drops toward CUTOFF_P_MIN (blows by
// most of the time), a weak handler vs a stopper rises toward CUTOFF_P_MAX.
const CUTOFF_BASE_P = 0.5;
const CUTOFF_PERIMD_W = 0.012; // per point of (defender perimD - handler handle)
const CUTOFF_SPEED_W = 0.01; // per point of (defender speed - handler speed)
const CUTOFF_IQ_W = 0.004; // per point of (defender iq - handler iq)
const CUTOFF_DRIVE_TEND_W = 0.013; // per point of handler driveRim tendency above 50: a rim-attacking team gets downhill / finishes getting there more (lowers the contain chance)
const CUTOFF_P_MIN = 0.1; // elite handlers still get walled occasionally
const CUTOFF_P_MAX = 0.85; // even weak handlers split a set defense sometimes
const CUTOFF_TO_BASE = 0.012; // base turnover chance once a drive is actually cut off (mostly the handler just picks it up)
const CUTOFF_TO_SPEED_SLOPE = 0.002; // faster into the wall → a bit more likely to charge/lose it
const CUTOFF_TO_HANDLE_SLOPE = 1 / 260; // a good handle reduces the cutoff turnover
const CUTOFF_TO_CAP = 0.04; // ceiling on cutoff turnover chance (cutoff strips/charges are rare; bad-pass TOs live elsewhere)
const CUTOFF_CHARGE_SHARE = 0.1; // of cutoff turnovers, share that are charges (rare, dead ball)
const CUTOFF_TRAVEL_SHARE = 0.12; // share that are travels (dead ball); the rest are live strips
// If the handler never USES the pick (resets out), the screen expires after a
// longer hold and the screener RELOCATES/spaces — it does NOT roll/pop. Roll/pop
// fires only on a SET screen the handler engaged (ob.screenSet && ob.screenUsed).
const SCREEN_HOLD_EXPIRE_BASE = 2.6; // base seconds an unused set screen is held before the screener gives up; scaled per screener (screenHoldExpire)
// Wait-for-the-pick: a screener heading to the handler's defender but not yet
// arrived (within this range of the on-ball defender) is "incoming" — the handler
// holds for it instead of attacking early, unless he already has a strong look.
const SCREEN_WAIT_RANGE = 15; // ft from the on-ball defender within which an approaching screen counts as incoming
const SCREEN_MIN_HANDLER_DIST = 14; // ft from rim: only call a ball screen for a perimeter handler (never a man on the block)
const SCREEN_MAX_HANDLER_DIST = 30; // ft from rim: above this the handler is too far out to call a useful ball screen
const SCREEN_PLANT_OFFSET = 2.0; // ft to the SIDE the pick spot sits beside the defender — INSIDE SCREEN_CONTACT_DIST so the screener actually bodies/impedes him (a real pick), not just sets positionally
const SCREEN_SIDE_EDGE = 4; // ft: the other side must be at least this much more open for the screener to switch which side he sets the pick (hysteresis so the choice doesn't oscillate)
const SCREEN_BODY_CLEAR = 3.0; // ft to the screener's outside shoulder (away from the on-ball defender) the handler aims when turning the corner — lateral component of the corner-turn
const SCREEN_CORNER_STEP = 4.0; // ft toward the rim past the screener the handler aims — rimward component of the corner-turn (so he rounds the pick, then attacks)
const SCREEN_TOWARD_HOOP = 3.2; // ft toward the basket the pick sits when there's no clear on-ball man
const SCREEN_TOWARD_MAX = 6; // ft: cap the pick's depth at the defender so a sagging man doesn't drag it into the paint
const SCREEN_LANE_DISCOUNT = 0.3; // off a SET pick, lane congestion bites only this fraction (the handler attacks downhill, his man screened)
const SCREEN_CALL_EXPIRE_BASE = 3.0; // base seconds a screen call lasts; scaled per handler (screenCallExpire)
const SCREEN_WAIT_GREAT = 2.7; // only a truly elite immediate look skips the called pick; otherwise the handler waits for it
const SCREEN_PICK_DIST_W = 1.4; // per ft from the handler: penalize picking a far screener
const SCREEN_PICK_ROLE_BONUS = 12; // the designated screener role is the natural pick

/* The screener's OWN read of where to set the pick — called by the screener each tick
   from his off-ball decider with LIVE positions (no central stored spot). He anchors on
   the on-ball defender (between the handler and the rim, containing him) and plants just
   beside him, off the handler's attack line, so he makes body contact and impedes him —
   the contact is what creates the separation the handler drives off. Expressed relative
   to the HANDLER so it tracks the play smoothly instead of chasing the defender's exact
   moving point. No clear on-ball man → aim a few feet toward the rim. */
function screenAnchor(handler: Player, screener: Player, h: Point, onBallDef: Player | null, def: Player[]): Point {
  const dx = onBallDef ? onBallDef.x - handler.x : h.x - handler.x;
  const dy = onBallDef ? onBallDef.y - handler.y : h.y - handler.y;
  const dl = Math.hypot(dx, dy) || 1;
  const tx = dx / dl,
    ty = dy / dl;
  const depth = onBallDef ? clamp(dl, 2, SCREEN_TOWARD_MAX) : SCREEN_TOWARD_HOOP;
  const perpX = -ty,
    perpY = tx;
  // The screener's DECISION: which side to set the pick. He reads the floor and angles
  // it to spring the handler toward the more OPEN side (the defender chasing him that way
  // runs into the pick). Openness of a side = how far the nearest help defender is from
  // where the handler would attack on it. He keeps the side he's already on unless the
  // other is clearly more open (a real advantage), so the choice is stable, not jittery.
  const curSide = (screener.y - handler.y) * perpY + (screener.x - handler.x) * perpX >= 0 ? 1 : -1;
  const openness = (sgn: number): number => {
    const ax = handler.x + tx * depth + sgn * perpX * 4;
    const ay = handler.y + ty * depth + sgn * perpY * 4;
    let nearest = 30;
    for (const d of def) {
      if (d === onBallDef) continue;
      nearest = Math.min(nearest, Math.hypot(d.x - ax, d.y - ay));
    }
    return nearest;
  };
  const side = openness(-curSide) > openness(curSide) + SCREEN_SIDE_EDGE ? -curSide : curSide;
  return {
    x: clamp(handler.x + tx * depth + side * perpX * SCREEN_PLANT_OFFSET, 3, COURT_L - 3),
    y: clamp(handler.y + ty * depth + side * perpY * SCREEN_PLANT_OFFSET, 3, 47),
  };
}

/* Pick the screener for a called ball screen: an able screener (screen tendency,
   role) who is CLOSE to the handler so he can actually get there — not a high-
   tendency player stranded in the corner. A man posting deep on the block is skipped
   (he's not coming out to ball-screen). */
function pickScreener(movers: Player[], bh: Player, h: Point): Player | null {
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const p of movers) {
    if (p === bh || !p.ob) continue;
    if (isInsidePlayer(p) && dist(p, h) < 8) continue;
    const score =
      effectiveTendencies(p).screen +
      (p.role === "screener" ? SCREEN_PICK_ROLE_BONUS : 0) -
      dist(p, bh) * SCREEN_PICK_DIST_W;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/* How long the HANDLER runs a called pick before giving up and attacking on his own —
   his patience, scaled by IQ (a heady guard milks the action; a low-IQ one bails early).
   Player-dependent, not a single global timer for everyone. */
function screenCallExpire(handler: Player): number {
  return SCREEN_CALL_EXPIRE_BASE * (0.7 + (handler.attr.iq / 100) * 0.6);
}

/* How long the SCREENER holds an unused set pick before relocating — scaled by his
   willingness to screen (screen tendency) and IQ; a willing, heady big stays on the body
   longer, a reluctant one bails sooner. */
function screenHoldExpire(screener: Player): number {
  const will = (effectiveTendencies(screener).screen + screener.attr.iq) / 2;
  return SCREEN_HOLD_EXPIRE_BASE * (0.7 + (will / 100) * 0.6);
}

/* ---------- PnR SCREEN CALL (shared coordination) ----------
   A CALL is pure coordination: the handler picks WHO screens for him; the chosen
   screener then decides WHERE to plant himself, each tick, by anchoring on the live
   on-ball defender in his own off-ball decider (screenAnchor). updateScreenCall runs
   each tick before the deciders: it creates the call when a perimeter handler is
   running a PnR, keeps the screener flagged as the committed screener, and clears the
   call when the pick is used / expires / the possession changes. No geometry here. */
export function updateScreenCall(): void {
  const call = G.screenCall;
  if (!call) return; // a call is CREATED by the handler's decision (applyScreenDecision, on wantsScreen)
  const bh = G.ball.holder;
  const ob = call.screener.ob;
  const handlerChanged = bh !== call.handler || G.ball.state !== "held";
  const expired = G.possClock - call.startClock > screenCallExpire(call.handler);
  const usedUp = !!ob?.screenUsed; // pick was used → screener rolls/pops, call done
  if (handlerChanged || expired || usedUp) {
    // unused/expired pick → release the screener back to spacing (no phantom roll)
    if (ob && ob.state === "screen" && !ob.screenSet) {
      ob.state = "space";
      ob.t = 0;
      ob.screenTarget = null;
    }
    G.screenCall = null;
    return;
  }
  // Keep the screener flagged as the committed screener — WHERE he goes is his own
  // per-tick read (screenAnchor on the live defender), computed in his off-ball decider.
  if (ob) {
    ob.state = "screen";
    ob.screenedThisPoss = true;
  }
}

/* The handler CALLS for a ball screen — HIS decision to initiate the PnR (a point guard
   waving a big up for a pick), not a play forced on him. He calls it when he's running a
   PnR, out on the perimeter with his dribble alive and time on the clock. Picks an able,
   close screener; the screener decides where to set it. Returns true if a call was made;
   the handler can still wave it off (rejectScreen) if his read changes before it sets. */
export function callScreen(bh: Player): boolean {
  if (G.ball.state !== "held") return false;
  if (tacFor(G.offense).action !== "pnr") return false;
  const h = hoop();
  const handlerDist = dist(bh, h);
  if (handlerDist <= SCREEN_MIN_HANDLER_DIST || handlerDist > SCREEN_MAX_HANDLER_DIST) return false;
  if (G.possClock < PNR_BRINGUP_DELAY || G.shotClock <= HOLD_MIN_CLOCK) return false;
  const off = offTeam();
  if (off.some((o) => o.ob?.screenedThisPoss)) return false; // one ball screen / possession
  const screener = pickScreener(
    off.filter((o) => o !== bh),
    bh,
    h,
  );
  if (!screener || !screener.ob) return false;
  G.screenCall = { screener, handler: bh, startClock: G.possClock };
  screener.ob.state = "screen";
  screener.ob.t = 0;
  return true;
}

/* The handler REJECTS / waves off a called screen before it sets — he changed his
   mind (saw a better look or chose to attack). Disperse the screener back to spacing
   and clear the call. Mark the screener screenedThisPoss so updateScreenCall doesn't
   immediately re-call the same pick — a wave-off spends the possession's one ball
   screen (no create→reject churn while the great look persists). */
export function rejectScreen(): void {
  const call = G.screenCall;
  if (!call) return;
  const ob = call.screener.ob;
  if (ob) ob.screenedThisPoss = true;
  if (ob && ob.state === "screen" && !ob.screenSet) {
    ob.state = "space";
    ob.t = 0;
    ob.screenTarget = null;
  }
  G.screenCall = null;
}

/* The handler's screen DECISION, from his on-ball read (BallDecision). Runs after
   decideOnBall but BEFORE the off-ball deciders, so the chosen screener reacts the SAME
   tick. He CALLS for a pick when he's stuck (wantsScreen) and none is live; he WAVES OFF
   a called pick that hasn't set once his read changes (a look opened up → wantsScreen
   flips false). This is where ball screens become deliberate rather than automatic. */
export function applyScreenDecision(ball: BallDecision | null): void {
  if (!ball) return;
  if (ball.wantsScreen && !G.screenCall) {
    callScreen(ball.who);
  } else if (ball.screenWaveOff && G.screenCall?.handler === ball.who && !G.screenCall.screener.ob?.screenSet) {
    rejectScreen();
  }
}

/* ---------- OFF-BALL UTILITY DECIDER ----------
   The off-ball mover is a per-tick utility decider. holdSpace is the baseline
   action (relocate to the best spacing spot); cut / screen / lift compete with it,
   their utilities built from the same conditions the legacy chance() gates read
   and modulated by effectiveTendencies. RESOLVE adds randn()*OFFBALL_NOISE to each
   utility and commits the winner. The weights are calibrated so the EMERGENT
   per-decision win-rate of each action lands near the legacy per-decision chance
   (cuts/screens/lifts happen at a realistic rate; holdSpace dominates otherwise).
   A committed cut/screen/fill is NOT re-scored — its lifetime is the same
   deterministic duration/abort the legacy state machine used. */
const OFFBALL_NOISE = 0.9; // stddev of the decision noise added per candidate in RESOLVE
const HOLD_SPACE_BASE = 1.0; // baseline holdSpace utility (the action to beat)
// cut: baseline + ball-reactive bonuses, ×driveRim tendency factor. The high pivot
// keeps cuts to a realistic rate against holdSpace+noise.
const CUT_UTIL_BASE = -2.2; // baseline basket-cut attraction (well below holdSpace)
const CUT_UTIL_PASS_BONUS = 0.9; // extra when a pass was just caught (motion off the catch)
const CUT_UTIL_EARLY_BONUS = 0.4; // extra early in the shot clock
const CUT_UTIL_OVERPLAY_BONUS = 1.1; // extra vs a tight ball-side denial (backdoor read)
const CUT_UTIL_LANE_BONUS = 0.7; // extra when the rim lane / passing lane is open
const CUT_UTIL_FINISH_W = 0.012; // per point of finishing above 50 (good finishers cut more)
const GIVEGO_UTIL_BONUS = 1.0; // extra cut attraction for the passer right after passing (give-and-go)
// screen: built from on-ball pressure on the handler + handler threat, ×screen tendency.
const SCREEN_UTIL_BASE = -2.6; // baseline screen attraction (below holdSpace)
const SCREEN_UTIL_PRESSURE_BONUS = 1.0; // extra when the handler is pressured (defender tight)
const SCREEN_UTIL_THREAT_W = 0.9; // per unit of handler threat (a dangerous handler is worth screening for)
// lift: weak-side relocation the moment the ball changes side. Mostly a spacing
// refresh, so it sits just under holdSpace and wins occasionally via noise.
const LIFT_UTIL_BASE = -1.4; // baseline lift attraction (just under holdSpace)
const LIFT_UTIL_BALLMOVE_BONUS = 1.0; // extra the tick a pass was just caught (ball changed side)

/* ---------- MOTION-OFFENSE INFLUENCES ----------
   Shared coordination principles that bias each off-ball player's EXISTING utility
   decisions so the five movers read as a single motion offense (not five players
   running around independently). Every weight is a bias on a candidate already
   scored above; none scripts a player. The triggers (handler driving + drive
   direction, a pass just happened, my man overplaying, a teammate vacated a spot)
   are read deterministically from the snapshot — no rng (that stays in RESOLVE).

   1) PUSH/PULL on drives: when the handler drives, a mover on the drive's side
      PUSHES (clears to the spot away from the lane); a mover away from the drive
      is PULLED to FILL the vacated ball-side gap. One coherent rule per player =
      globally coherent spacing, replacing the old single weak-side relocate. */
const DRIVE_PUSH_DEPTH_MAX = 19; // ft from hoop within which a same-side mover clears the lane
const DRIVE_PULL_ON = false; // weak-side corner-lift on a drive (see the PULL block for why it's off in this build)
const DRIVE_PULL_PENETRATION = 13; // ft handler-to-rim within which a weak-side man lifts to fill the ball-side corner (the genuine collapse moment)
// 2) PASS-AND-MOVE: never stand still. The passer's give-and-go is GIVEGO_UTIL_BONUS
//    above; additionally every mover takes a small holdSpace penalty once he's been
//    stationary, so someone is always moving with purpose.
const IDLE_DWELL_T = 2.6; // seconds settled at a spot before the idle penalty applies (long: only true standing-around)
const IDLE_HOLD_PENALTY = 0.0; // OFF: a weak-side idle nudge measurably trades away rim finishes in this engine for no coordination payoff; the give-and-go / lift / push / corner-fill already keep the off-ball four flowing. Hook kept (dial up if play looks static).
// 4) FILL THE VACATED SPOT: when a teammate is cutting/has vacated his home spot, a
//    nearby free mover biases to relocate into that open spot (floor balance —
//    corners filled). Collisions broken by the existing spacing repulsion + the
//    fixed mover order (earlier index claims the fill first).
const FILL_VACATED_BONUS = 0.7; // lift-util bonus to fill an EMPTY corner a cutter vacated (gentle: nudges floor balance, doesn't out-compete a rim cut)
const FILL_VACATED_RADIUS = 12; // ft: a mover this close to a vacated spot is the one who fills it
const FILL_VACATED_MIN_GAP = 6; // ft: only fill if the mover is genuinely OUT of position (>this from the vacated spot) — else he's effectively already there
// 5) ACTIVE PLAY AS BIAS: "motion" leans the pass-and-move / cut / fill bonuses up;
//    "pnr" keeps them at baseline (the screen action carries its own bonus). The
//    play INFLUENCES, never dictates.
const MOTION_ACTION_SCALE = 1.35; // multiplier on motion bonuses under the "motion" action
const PNR_ACTION_SCALE = 1.0; // baseline under "pnr" (screen prominence handled elsewhere)

const SPACE_DWELL_MIN = 1.5; // seconds a player holds its spot after each relocation before re-evaluating
const RETARGET_MIN_SHIFT = 2.5; // ft: ignore retarget if new target is closer than this to current

/* ---------- BALL-DRIVEN FORMATION (helios-base model) ----------
   The off-ball DEFAULT (holdSpace) is no longer "hunt the best open spot" — that
   re-scored, noisy spot search is what made the four movers wander independently.
   Instead each mover owns a FIXED base slot (his perimeterSpots/insideSpots home)
   and his holdSpace target is that slot SHIFTED smoothly by the BALL position. Every
   home is the same smooth function of one ball position, so when the ball moves all
   four homes slide together as a unit (coherent, organized) and spacing is preserved.
   Cuts/screens/backdoor/lift remain UTILITY deviations layered on top — when a
   trigger fires the player breaks off the formation; otherwise he holds his home.

   The shift is computed from a COARSE (banded) read of the ball position rather
   than the raw continuous coordinate, so the home is piecewise-constant: it stays
   put while the ball moves within a band and only jumps when the ball crosses into
   a new band. This is what keeps the off-ball four CALM (few retargets) while still
   shifting coherently as a unit when the ball genuinely changes side/depth — the
   discreteness is the hysteresis the helios dead-zone provides, baked into the home.

   - STRONG-SIDE SLIDE: the ball's y maps to one of three bands (bottom / middle /
     top). The slot slides toward the ball's band-side by a fixed amount, bounded so
     the weak side stays occupied (we never collapse everyone onto the ball).
   - DEPTH ADJUST: the ball's depth maps to two bands (up high vs worked low). High
     ball → perimeter slots a touch out; low ball → a touch in (passing angle).
   Deterministic: a pure function of (slot, banded ball, hoop). No rng. */
const FORM_SLIDE_FT = 2.0; // ft the slot leans toward the ball's strong-side band
// Wide neutral zone: a handler probing around the top (y≈25) does NOT shift the
// formation; only a genuine side entry (ball worked to a wing/corner) leans the
// shape. This is what stops the off-ball four from reshuffling on every perimeter
// dribble — they hold until the ball really changes side.
const FORM_BAND_LO = 15; // ball y below this = bottom-side band
const FORM_BAND_HI = 35; // ball y above this = top-side band
const FORM_DEPTH_FT = 1.5; // ft the perimeter slot lifts/sinks with the ball depth band
// Single wide depth boundary (hysteresis-friendly): the ball is "low" once it's
// driven well inside, else "high". One boundary → at most one depth flip a trip.
const FORM_DEPTH_HI = 999; // disabled upper band (no separate "extra high" tier)
const FORM_DEPTH_LO = 13; // ball depth below this = "worked low" (driven inside)
const FORM_DEADZONE_MIN = 2.5; // ft: floor on the retarget dead-zone (helios uses ballDist*0.1)
const FORM_DEADZONE_FRAC = 0.1; // ballDist fraction for the dead-zone (helios dist_thr = ballDist*0.1)

/* The ball-driven home for one slot: the slot's base home shifted by a COARSE
   (banded) read of the ball position. `inside` players (bigs) get a gentler slide
   and no depth lift (they work the dunker/short-corner band). Because the shift is
   banded (piecewise-constant in the ball y/depth), the home barely moves while the
   ball works within a band and every slot uses the SAME band → all four slide
   together as a unit when the ball changes side/depth (coherent). The dead-zone at
   the call site holds the target through the small within-band variation. */
function formationHome(home: Point, ball: Point, h: Point, dir: number, inside: boolean): Point {
  // STRONG-SIDE SLIDE: ball-side band (−1 bottom / 0 middle / +1 top). The shape
  // leans ball-side by LIFTING THE WEAK SIDE toward the ball, NOT by crushing the
  // strong side into the baseline (which would stack a wing onto a corner). So the
  // slide is scaled by how far the slot sits on the WEAK side of center: a weak-side
  // slot slides toward the ball; a slot already on the ball side barely moves. This
  // preserves corner spacing and keeps the four spread while the set leans ball-ward.
  const ballBand = ball.y < FORM_BAND_LO ? -1 : ball.y > FORM_BAND_HI ? 1 : 0;
  // (home.y - 25) * (-ballBand) > 0 exactly when the slot is on the WEAK side of
  // the ball: that slot slides toward the ball; a strong-side slot gets frac≈0.
  const weakSideFrac = ballBand === 0 ? 0 : clamp((home.y - 25) * -ballBand, 0, 22) / 22;
  // Bigs barely lean: they work fixed block/dunker spots, so a strong slide would
  // shift where they crash for boards (it measurably perturbs the mass-rebound
  // edge). The visible formation coherence comes from the perimeter four.
  const slide = ballBand * FORM_SLIDE_FT * weakSideFrac * (inside ? 0.2 : 1);
  // DEPTH ADJUST: two-band depth read; perimeter slots only.
  const ballDepth = Math.abs(ball.x - h.x);
  const depthBand = ballDepth > FORM_DEPTH_HI ? 1 : ballDepth < FORM_DEPTH_LO ? -1 : 0;
  const depthShift = inside ? 0 : depthBand * FORM_DEPTH_FT;
  return { x: home.x + dir * depthShift, y: clamp(home.y + slide, 3, 47) };
}
const TARGET_MIN_PERIMETER_DIST = 12; // classic motion spacing: keep perimeter slots a full gap apart
const TARGET_MIN_INTERIOR_DIST = 7.5; // interior players can be closer, but not stacked
const TARGET_MIN_MIXED_DIST = 9.5; // one inside / one perimeter needs a passing lane gap
const HIGH_POST_MIN_DEPTH = 9; // relative to hoop: FT-line/high-post band starts here
const HIGH_POST_MAX_DEPTH = 17;
const HIGH_POST_MIN_Y = 17;
const HIGH_POST_MAX_Y = 33;
// A lane-camping player must START clearing with enough lead time to physically
// vacate the paint before the 3.0s violation — a slow big needs ~1s to cover the
// ~10 ft out of the lane, so the warn fires well under the limit (was 1.7/0.9,
// which left a slow/low-IQ big too little runway and produced 3-second calls).
const LANE_CLEAR_WARN_T = 1.4;
const LANE_CLEAR_LOW_IQ_EXTRA_T = 0.4;

type ReservedTarget = { p: Player; point: Point; inside: boolean };

/* ---------- 4) OFFENSE RESOLVE ----------
   Resolves the off-ball movement intents (resolveOffBall: ob state machine + all
   off-ball rng + the pnr PHASE logic) every tick, then on the decideCD cadence
   runs the BALL block: the on-ball strip roll, the decision noise, the drive-
   cutoff rolls, the selection precedence, and execution — all the rng and mutation
   the pure decideOnBall deferred. This is the only offensive phase that mutates
   game-logic state or consumes rng. See docs/decide-pipeline-design.md and the
   RESOLVE SPEC.

   Off-ball movement runs in resolveOffBall (a resolve-phase unit — see its header
   for why off-ball is not a pure decide→resolve split). The ball-handler IS a
   clean split: `ball` is decideOnBall(s)'s scored output (null when no holder),
   and this function applies the noise + selection + execution. */
export function resolveOffense(
  s: Snapshot,
  ball: BallDecision | null,
  offBallIntents: OffBallDecision[],
): void {
  const off = offTeam(),
    def = defTeam(),
    h = hoop(),
    tac = tacFor(G.offense);
  const tuning = simTunables();
  // ----- off-ball: apply decided targets + state machine + rng + pnr phase logic -----
  resolveOffBall(s, offBallIntents);

  // ----- ball-handler resolution (every decideCD ticks) -----
  if (G.decideCD > 0) {
    G.decideCD--;
    return;
  }
  G.decideCD = 4; // decide ~ every 0.4s
  const bh = G.ball.holder;
  if (!bh) return;
  recordTouch(bh.name);

  // ----- A) on-ball turnover / strip check (before any shoot/drive/pass) -----
  {
    const onBallDef = def.find((d) => d.assign === bh) || nearestDef(bh, def).d;
    if (onBallDef) {
      const stealEdge = (onBallDef.attr.steal - handleOf(bh)) * STRIP_STEAL_SLOPE;
      const iqEdge = (onBallDef.attr.iq - bh.attr.iq) * STRIP_IQ_SLOPE;
      let tovP =
        (ON_BALL_TOV_BASE + Math.max(0, stealEdge) + Math.max(0, iqEdge)) *
        tuning.turnovers.onBallScale *
        STRIP_PRESSURE_MULT[tac.pressure] *
        tendencyFactor(effectiveTendencies(onBallDef).gambleSteal);
      if (G.driving) tovP *= STRIP_DRIVE_MULT;
      tovP = clamp(tovP, 0, ON_BALL_TOV_CAP);
      if (chance(tovP)) {
        bh.stats.tov++;
        recordTO("strip", bh, dist(bh, h));
        if (chance(STRIP_CLEAN_SHARE)) {
          onBallDef.stats.stl++;
          logEv(`${onBallDef.name} strips ${bh.name} — steal!`, "to");
          G.driving = false;
          beginLiveTransition(onBallDef, true);
        } else {
          const recover = nearestDef(bh, def).d || onBallDef;
          logEv(`${bh.name} loses the handle — turnover`, "to");
          G.driving = false;
          beginLiveTransition(recover);
        }
        return;
      }
    }
  }

  // The strip roll did not turn it over; if there's no scored decision (no
  // holder at decide time) bail. `ball` is computed from the same snapshot.
  if (!ball || ball.who !== bh) return;

  const { type, contest, mp, pts, open, dh, bestPass, bestPU, postDef, postEdge, toward } = ball;
  let { shootU, driveU, passU, postU } = ball;

  // Putback consume: the scoring bonus was already applied pre-noise in decide;
  // the side-effect clear happens here whether or not he ends up shooting.
  G.putbackBy = null;

  // ----- B) low IQ adds noise to the choice -----
  const noise = ((99 - bh.attr.iq) / 99) * 0.6;
  shootU += randn() * noise;
  driveU += randn() * noise;
  passU += randn() * noise;
  if (postU > 0) postU += randn() * noise;

  // ----- C) drive cutoff: matchup roll + turnover/charge/travel rolls -----
  if (G.driving && dh < LAYUP_ATTACK_DIST && dh > LAYUP_GO_UP_DIST) {
    const cutoffDef = driveCutOff(bh, def, h);
    let contained = false;
    if (cutoffDef) {
      if (cutoffDef.assign === bh) {
        if (G.driveBeaten === undefined) {
          const edge =
            (cutoffDef.attr.perimD - handleOf(bh)) * CUTOFF_PERIMD_W +
            (cutoffDef.attr.speed - bh.attr.speed) * CUTOFF_SPEED_W +
            (cutoffDef.attr.iq - bh.attr.iq) * CUTOFF_IQ_W -
            (effectiveTendencies(bh).driveRim - 50) * CUTOFF_DRIVE_TEND_W;
          G.driveBeaten = !chance(clamp(CUTOFF_BASE_P + edge, CUTOFF_P_MIN, CUTOFF_P_MAX));
        }
        contained = !G.driveBeaten;
        if (!contained) recordDecision("driveBeat");
      } else {
        const onBallBeaten = (() => {
          const ob = def.find((d) => d.assign === bh) || nearestDef(bh, def).d;
          return ob ? dist(ob, h) > dh - LAYUP_BEATEN_BEHIND || dist(ob, bh) > LAYUP_BEATEN_GAP : true;
        })();
        contained = !onBallBeaten || laneWallCount(bh, def, h) >= 2;
      }
    }
    if (cutoffDef && contained) recordDecision("contained");
    if (cutoffDef && contained) {
      G.driving = false;
      const driveSpeed = Math.hypot(bh.vx, bh.vy);
      const toP = clamp(
        CUTOFF_TO_BASE + driveSpeed * CUTOFF_TO_SPEED_SLOPE - (handleOf(bh) - 60) * CUTOFF_TO_HANDLE_SLOPE,
        0,
        CUTOFF_TO_CAP,
      );
      if (chance(toP)) {
        bh.stats.tov++;
        recordTO("cutoff", bh, dh);
        const r = rng();
        if (r < CUTOFF_CHARGE_SHARE) {
          logEv(`${cutoffDef.name} draws a charge on ${bh.name} — offensive foul, turnover`, "to");
          beginScoreTransition(true);
        } else if (r < CUTOFF_CHARGE_SHARE + CUTOFF_TRAVEL_SHARE) {
          logEv(`${bh.name} gets cut off and travels — turnover`, "to");
          beginScoreTransition(true);
        } else {
          cutoffDef.stats.stl++;
          logEv(`${cutoffDef.name} cuts off the drive and strips ${bh.name} — steal!`, "to");
          beginLiveTransition(cutoffDef, true);
        }
        return;
      }
      driveU = -1;
    }
  }

  // ----- D) selection + execution -----
  const best = Math.max(shootU, driveU, passU, postU);

  const noGoodAttack = Math.max(shootU, driveU) < HOLD_GO_THRESHOLD;
  const noGoodPass = bestPU < HOLD_PASS_QUALITY;
  const haveGreatStandstillShot = shootU >= SCREEN_WAIT_GREAT;
  // Wait for the called pick (helios give-and-go model): while a screen CALL is live
  // for this handler and the pick hasn't SET yet, he HOLDS STILL near the pick spot so
  // the screener can rendezvous and plant. Once it sets he attacks off the separation.
  const call = G.screenCall;
  const waitForScreen =
    !!call &&
    call.handler === bh &&
    !call.screener.ob?.screenSet &&
    !haveGreatStandstillShot &&
    best !== postU &&
    G.shotClock > HOLD_MIN_CLOCK;
  const wantHold =
    waitForScreen ||
    (noGoodAttack &&
      noGoodPass &&
      best !== postU &&
      G.shotClock > HOLD_MIN_CLOCK &&
      (G.holdT ?? 0) < HOLD_MAX_T);
  if (wantHold) {
    G.holdT = (G.holdT ?? 0) + 0.4;
    G.driving = false;
    recordDecision("hold");
    if (waitForScreen) {
      bh.target = { x: bh.x, y: bh.y }; // hold near the pick spot so the screener can plant
    } else {
      holdAndProbe(bh, off, def, h);
    }
    return;
  }

  if (best === postU && postU > 0) {
    G.driving = false;
    recordDecision("post");
    postUp(bh, postDef!, contest, postEdge);
  } else if (best === shootU && (open > 0.2 || G.shotClock < 8 || dh < 6 || bh.catchShoot)) {
    G.driving = false;
    bh.catchShoot = false;
    recordDecision("shoot");
    attemptShot(bh, type, contest, pts, mp);
  } else if (best === driveU) {
    if (!G.driving) G.driveBeaten = undefined; // fresh drive → re-roll the matchup next tick
    G.driving = true;
    recordDecision("drive");
    // Attack AROUND the pick, not straight at the rim. If a teammate is setting a screen
    // between the handler and the basket, the handler turns the corner: he aims at the
    // screener's OUTSIDE shoulder (lateral, the side away from his on-ball defender) AND a
    // step toward the rim — a real two-component corner, so his path visibly bends around
    // the screener and rubs the chasing defender into him. A waypoint blended mostly
    // rimward (the old version) bent the path too little to read. Otherwise: straight downhill.
    const screener = off.find((o) => o !== bh && o.ob?.state === "screen");
    if (screener) {
      const onBall = def.find((d) => d.assign === bh) ?? nearestDef(bh, def).d;
      // lateral unit: from the on-ball defender out to the screener (his outside shoulder)
      let lx = screener.x - (onBall?.x ?? bh.x);
      let ly = screener.y - (onBall?.y ?? bh.y);
      const ll = Math.hypot(lx, ly) || 1;
      lx /= ll;
      ly /= ll;
      // rimward unit: handler toward the basket
      let rx = h.x - bh.x;
      let ry = h.y - bh.y;
      const rl = Math.hypot(rx, ry) || 1;
      rx /= rl;
      ry /= rl;
      bh.target = {
        x: clamp(screener.x + lx * SCREEN_BODY_CLEAR + rx * SCREEN_CORNER_STEP, 3, COURT_L - 3),
        y: clamp(screener.y + ly * SCREEN_BODY_CLEAR + ry * SCREEN_CORNER_STEP, 3, 47),
      };
    } else {
      bh.target = toward;
    }
  } else if (bestPass) {
    G.driving = false;
    recordDecision("pass");
    startPass(bh, bestPass);
  } else {
    G.driving = false;
    recordDecision("shoot");
    attemptShot(bh, type, contest, pts, mp);
  } // nothing better, just shoot
}

/* Drive cutoff: returns the defender who has stepped into the driver's near path
   — goal-side, just ahead, inside the lane corridor — walling off the drive, or
   null if the lane ahead is clear. This includes the on-ball defender: if he's
   still in front (not beaten) he cuts the drive off himself; a beaten man is
   behind the ball (along < 0) and is naturally ignored. */
function driveCutOff(bh: Player, def: Player[], h: Point): Player | null {
  const dx = h.x - bh.x,
    dy = h.y - bh.y,
    len = Math.hypot(dx, dy) || 1;
  const ux = dx / len,
    uy = dy / len;
  let nearest: Player | null = null,
    nearestAlong = 1e9;
  for (const d of def) {
    const tx = d.x - bh.x,
      ty = d.y - bh.y;
    const along = tx * ux + ty * uy; // how far ahead toward the rim
    if (along < 0.5 || along > CUTOFF_AHEAD) continue;
    const perp = Math.abs(tx * uy - ty * ux);
    if (perp < CUTOFF_WIDTH && along < nearestAlong) {
      nearestAlong = along;
      nearest = d;
    }
  }
  return nearest;
}

/* Counts defenders walling the driving lane ahead (a wider corridor than the
   cutoff test, including the on-ball man). Two or more is a genuine collapse the
   driver can't split; one is a single rotation he attacks and finishes over. */
function laneWallCount(bh: Player, def: Player[], h: Point): number {
  const dx = h.x - bh.x,
    dy = h.y - bh.y,
    len = Math.hypot(dx, dy) || 1;
  const ux = dx / len,
    uy = dy / len;
  let n = 0;
  for (const d of def) {
    const tx = d.x - bh.x,
      ty = d.y - bh.y;
    const along = tx * ux + ty * uy;
    if (along < 0.5 || along > CUTOFF_AHEAD + 1.5) continue;
    if (Math.abs(tx * uy - ty * ux) < CUTOFF_WIDTH + 0.5) n++;
  }
  return n;
}

/* Dribble out / around the perimeter toward whichever perimeter spot is most
   open, so the handler probes a new angle instead of standing or forcing it.
   Eases toward the target so it reads as a live dribble, not a teleport. */
function perimeterDribbleTarget(bh: Player, def: Player[], h: Point, dir: number): Point {
  const R = 23;
  const cands: Point[] = [
    { x: h.x + dir * R, y: 25 }, // top
    { x: h.x + dir * (R * 0.62), y: 9 }, // left wing
    { x: h.x + dir * (R * 0.62), y: 41 }, // right wing
  ];
  let best = cands[0],
    bestOpen = -1;
  for (const c of cands) {
    if (dist(bh, c) < 4) continue; // skip where he already is
    const { dd } = nearestDef(c as Player, def);
    if (dd > bestOpen) {
      bestOpen = dd;
      best = c;
    }
  }
  return { x: lerp(bh.x, best.x, 0.35), y: lerp(bh.y, best.y, 0.35) };
}

/* Patience hold: with no compelling attack, the handler keeps his dribble and
   dribbles out / around the top to find a new angle — the natural reset a guard makes
   around 12-15s on the clock. Meanwhile a weak-side man may cut. The next decision
   cycle reacts to whatever opens, so we never force a bad pass. Ball SCREENS are NOT
   spawned here: a pick is the handler's own call (callScreen / applyScreenDecision),
   the single owner of the screen — spawning a second one here re-picked a screener who
   had already rolled (the duplicate-roll glitch) and bypassed the one-per-possession
   guard. */
function holdAndProbe(bh: Player, off: Player[], def: Player[], h: Point): void {
  const dir = G.attackHoop === "R" ? -1 : 1;

  // A guard/primary playmaker resets the offense around 12-15s: dribble back out
  // toward the top to reset spacing and start a second action.
  const resetWindow = G.shotClock <= HOLD_RESET_CLOCK_HI && G.shotClock >= HOLD_RESET_CLOCK_LO;
  const playmaker = bh.role === "handler" || bh.attr.pass >= 70;

  if (resetWindow && playmaker) {
    // reset: dribble back out to the top of the key
    bh.target = { x: lerp(bh.x, h.x + dir * 24, 0.45), y: lerp(bh.y, 25, 0.4) };
  } else {
    // dribble out / around the perimeter toward the most open spot for a new angle
    bh.target = perimeterDribbleTarget(bh, def, h, dir);
  }

  // occasional basket cut from a weak-side perimeter man to create movement
  if (chance(HOLD_CUT_CHANCE)) {
    for (const p of off) {
      if (p === bh || isInsidePlayer(p) || !p.ob || p.ob.state !== "space") continue;
      const cf = tendencyFactor(effectiveTendencies(p).driveRim);
      if (chance(cf * 0.5)) {
        p.ob.state = "cut";
        p.ob.t = 0;
        p.ob.cutY = p.y < 25 ? 19 : 31;
        p.target = { x: h.x + dir * 2.5, y: p.ob.cutY };
        break;
      }
    }
  }
}

/* Back-down post-up: a CLOSE shot whose make probability is bumped UP by the
   handler's physical edge (clamped), with a foul-draw chance routed through the
   normal beginFouled path so bigs get to the line. Determinism via chance(). */
function postUp(bh: Player, d: Player, contest: number, edge: number): void {
  bh.target = { x: bh.x, y: bh.y };
  logEv(`${bh.name} backs down ${d.name} in the post`);
  // physical foul-draw on the backdown -> trip to the line (no FGA on a miss).
  const foulP = clamp(POST_FOUL_BASE + Math.max(0, edge) * POST_FOUL_EDGE_SLOPE, 0, POST_FOUL_CAP);
  const base = makeProb(bh, "close", contest);
  const bump = clamp(Math.max(0, edge) * POST_EDGE_MULT, 0, POST_EDGE_MAKE_CAP);
  const mp = clamp(base + bump, 0.02, 0.97);
  if (chance(foulP)) {
    beginFouled(bh, "close", 2, chance(mp)); // and-one if the bumped look would have fallen
    return;
  }
  attemptShot(bh, "close", contest, 2, mp);
}

/* Returns true when no defender lies within the lane corridor between the
   ball-handler and the hoop. The corridor is a strip OPEN_LANE_CORRIDOR_WIDTH
   ft wide centered on the direct path to the basket. */
function isLaneClear(bh: Player, def: Player[], h: Point): boolean {
  for (const d of def) {
    if (d.assign === bh) continue; // on-ball defender is expected to be there
    const dx = h.x - bh.x,
      dy = h.y - bh.y,
      len = Math.hypot(dx, dy);
    if (len < 0.1) continue;
    const ux = dx / len,
      uy = dy / len;
    const tx = d.x - bh.x,
      ty = d.y - bh.y;
    const along = tx * ux + ty * uy;
    if (along < 0 || along > len) continue; // outside handler-to-hoop segment
    const perp = Math.abs(tx * uy - ty * ux);
    if (perp < OPEN_LANE_CORRIDOR_WIDTH) return false;
  }
  return true;
}

/* Returns true when a help defender has stepped toward the driving ball-handler
   (i.e., the driver has drawn help, opening a kick-out target). */
function helpCommittedToDriver(bh: Player, def: Player[], h: Point): boolean {
  for (const d of def) {
    if (d.assign === bh) continue;
    if (dist(d, bh) < DRIVE_KICK_HELP_DIST) return true;
  }
  return false;
}

/* Returns true when a given defender has left his man to help on the driver.
   Used to identify which offensive player is now open for the kick-out. */
function isHelping(d: Player, driver: Player, h: Point): boolean {
  return dist(d, driver) < DRIVE_KICK_HELP_DIST && (!d.assign || dist(d, d.assign) > 5);
}

/* Returns the pass-utility bonus for feeding a teammate who is posting up near
   the basket with a meaningful physical edge over his on-ball defender. */
function postFeedValue(t: Player, def: Player[], h: Point): number {
  const td = dist(t, h);
  if (td > POST_FEED_RANGE) return 0;
  const tend = effectiveTendencies(t);
  if (tend.postUp < POST_FEED_TEND_PIVOT) return 0;
  const tDef = def.find((d) => d.assign === t);
  if (!tDef) return 0;
  const edge = postOffenseRating(t) - postDefenseRating(tDef);
  if (edge < POST_FEED_EDGE_MIN) return 0;
  // Don't feed into a collapsed paint / double-team: if a second defender (beyond
  // his own man) is sitting on the post, the entry pass is a turnover waiting to
  // happen. This is what keeps clustered bigs from forcing feeds into traffic.
  let near = 0;
  for (const d of def) if (dist(d, t) < POST_FEED_SMOTHER_R) near++;
  if (near >= 2) return 0;
  // a bigger mismatch is a more attractive feed; a routine matchup is a modest nudge
  return POST_FEED_PASS_BONUS * tendencyFactor(tend.postUp) * clamp(edge / 10, 0.3, 1.5);
}

function rimHelp(bh: Player, def: Player[], h: Point): number {
  // how protected is the rim right now (0..1)
  let v = 0;
  for (const d of def) {
    if (dist(d, h) < 7) v += clamp((d.attr.interiorD + d.attr.block) / 200, 0, 0.6);
  }
  return clamp(v, 0, 1);
}

/* ---------- OFF-BALL SHARED SETUP ----------
   The deterministic spacing inputs both decideOffBall and resolveOffBall need:
   the mover list (non-handler offensive players — the pnr screener is now a normal
   mover/decider), their role-true perimeter/inside home spots, the defender-by-
   assignment index, the designated pnr screener (under the pnr macro-intent), and
   the ball-reactive context (driving, justPassed, passer, earlyClock). Pure: reads
   frozen-equivalent live state, no rng, no mutation. */
interface OffBallSetup {
  off: Player[];
  def: Player[];
  h: Point;
  dir: number;
  bh: Player;
  spots: Point[];
  perimeterSpots: Point[];
  insideSpots: Point[];
  homeOf: Map<Player, Point>;
  defByAssign: Map<Player, Player>;
  movers: Player[];
  pnrScreener: Player | null;
  driving: boolean;
  driveSideLow: boolean; // the drive lane is on the bottom (y<25) half of the floor
  motionScale: number; // active-play scale on the motion bonuses (tac.action)
  justPassed: boolean;
  passer: Player | null;
  earlyClock: number;
}

/* The designated ball-screener under the pnr macro-intent: the eligible mover with
   the highest (effective) screen tendency, role==="screener"/off[4] as the seed and
   tiebreak. Null when the play isn't pnr or the would-be screener has the ball.
   Mirrors the legacy phase-machine pick so the same big sets the pick. */
function designatedScreener(off: Player[], movers: Player[], bh: Player, tac: Tactics): Player | null {
  if (tac.action !== "pnr") return null;
  let screener = off.find((p) => p.role === "screener") || off[4];
  let bestScreen = !screener || screener === bh ? -1 : effectiveTendencies(screener).screen;
  for (const p of movers) {
    const sc = effectiveTendencies(p).screen;
    if (sc > bestScreen) {
      bestScreen = sc;
      screener = p;
    }
  }
  return screener && screener !== bh ? screener : null;
}

function offBallSetup(s: Snapshot, bh: Player): OffBallSetup {
  const off = offTeam(),
    def = defTeam(),
    h = hoop(),
    tac = s.tacOff;
  const dir = G.attackHoop === "R" ? -1 : 1;
  const spots = spotsFor(G.attackHoop);
  const driving = !!G.driving && dist(bh, h) < 20;
  // The drive lane runs from the handler toward the rim; its lateral side is the
  // midpoint of that segment, so a handler driving baseline from the top still
  // reads as committing to one side. Push/pull keys off this, not the raw bh.y.
  const driveSideLow = (bh.y + h.y) / 2 < 25;
  const motionScale = tac.action === "motion" ? MOTION_ACTION_SCALE : PNR_ACTION_SCALE;
  const justPassed = G.decideCD === 3;
  const passer = G.pendingAssist || null;
  const earlyClock = clamp((G.shotClock - (24 - CUT_EARLY_CLOCK_T)) / CUT_EARLY_CLOCK_T, 0, 1);

  const movers: Player[] = [];
  for (const p of off) {
    if (p === bh) continue;
    movers.push(p); // the pnr screener is now a normal off-ball decider (no exclusion)
  }
  const pnrScreener = designatedScreener(off, movers, bh, tac);
  const bigs = movers.filter(isInsidePlayer);
  const perimeterSpots = [spots[1], spots[2], spots[3], spots[4]];
  const insideSpots: Point[] = [
    { x: h.x + dir * INSIDE_SHORT_X, y: 13 },
    { x: h.x + dir * INSIDE_SHORT_X, y: 37 },
    { x: h.x + dir * DUNKER_X, y: 13 },
    { x: h.x + dir * DUNKER_X, y: 37 },
  ];
  const sortByObSpot = (a: Player, b: Player) => (a.ob?.spot ?? 0) - (b.ob?.spot ?? 0);
  const shooters = movers.filter((p) => !isInsidePlayer(p)).sort(sortByObSpot);
  bigs.sort(sortByObSpot);
  const homeOf = new Map<Player, Point>();
  shooters.forEach((p, i) => homeOf.set(p, perimeterSpots[i % perimeterSpots.length]));
  bigs.forEach((p, i) => homeOf.set(p, insideSpots[i % insideSpots.length]));

  const defByAssign = new Map<Player, Player>();
  for (const x of def) if (x.assign && !defByAssign.has(x.assign)) defByAssign.set(x.assign, x);

  return {
    off,
    def,
    h,
    dir,
    bh,
    spots,
    perimeterSpots,
    insideSpots,
    homeOf,
    defByAssign,
    movers,
    pnrScreener,
    driving,
    driveSideLow,
    motionScale,
    justPassed,
    passer,
    earlyClock,
  };
}

/* ---------- 4) OFF-BALL DECIDE (pure, utility) ----------
   The pure off-ball UTILITY decider. For each non-handler mover:
   - MID-COMMITMENT (in cut / fill / screen): return the deterministic continuation
     target flagged `committed` — do NOT re-score (hysteresis; prevents jitter). The
     commitment's lifetime/abort is the same deterministic duration the legacy state
     machine used (handled in RESOLVE).
   - FREE (in "space"): compute the holdSpace spacing target (the reserved-set pass)
     and SCORE the candidate actions — holdSpace, cut (basket / backdoor / give-and-
     go), screen (for the handler), lift (weak-side relocation) — each modulated by
     effectiveTendencies. RESOLVE adds noise, picks the winner, and commits it.
   Spacing uses the reserved-set pass (movers in fixed order, each chosen target
   accumulated). Pure: reads only the snapshot, no rng, no mutation of G/ob/targets.
   This reserved set does NOT see same-tick commitments of earlier movers (those are
   committed in resolve); that 1-tick spacing lag is the intended behavior change.
   See docs/decide-pipeline-design.md. */
export function decideOffBall(s: Snapshot): OffBallDecision[] {
  const bh = G.ball.holder;
  if (!bh) return []; // ball in flight: resolve holds spacing, no per-mover decisions
  const { off, def, h, dir, spots, perimeterSpots, insideSpots, homeOf, defByAssign, movers, pnrScreener, driving, driveSideLow, motionScale, justPassed, passer, earlyClock } =
    offBallSetup(s, bh);
  const out: OffBallDecision[] = [];

  const reserved: ReservedTarget[] = [];
  if (bh.target) reserved.push({ p: bh, point: bh.target, inside: false });
  for (const p of offTeam()) {
    if (p === bh || movers.includes(p) || !p.target) continue;
    reserved.push({ p, point: p.target, inside: p.role === "screener" || isInsidePlayer(p) });
  }
  // snapshot-derived reservations (decide does NOT see same-tick commitments)
  // Push and pull each fire at most once per tick (one mover clears the lane, one
  // mover fills the gap) so the drive shifts the floor coherently without everyone
  // relocating at once (which would look busy / break spacing).
  let drivePushUsed = false;
  let drivePullUsed = false;
  const cutCommitted = movers.some((p) => p.ob?.state === "cut");
  const screenCommitted = movers.some((p) => p.ob?.state === "screen");

  // FILL THE VACATED SPOT (principle 4): when a CORNER spot's owner has cut away
  // from it AND no other offensive player is occupying it, a nearby free mover is
  // gently nudged to fill it so the floor stays balanced (corners filled, spacing
  // preserved). Restricted to corners (the spacing-critical spots the principle
  // emphasizes) and to genuinely EMPTY spots so it doesn't constantly convert
  // would-be cutters into perimeter fillers. Bigs keep their inside homes.
  const isCorner = (pt: Point): boolean => pt.y <= 10 || pt.y >= 40;
  const occupiedByOffense = (pt: Point): boolean => offTeam().some((o) => dist(o, pt) < FILL_VACATED_MIN_GAP);
  const vacatedSpots: Point[] = [];
  for (const p of movers) {
    if (isInsidePlayer(p) || p.ob?.state !== "cut") continue;
    const home = homeOf.get(p);
    if (!home || !isCorner(home) || occupiedByOffense(home)) continue;
    vacatedSpots.push(home);
  }
  let fillClaimed = false; // one filler per vacated spot per tick (fixed mover order)

  // on-ball defender pressure on the handler (drives the screen utility)

  // on-ball defender pressure on the handler (drives the screen utility)
  const onBallDef = def.find((dd) => dd.assign === bh) || nearestDef(bh, def).d;
  const handlerPressure = onBallDef ? clamp(1 - dist(onBallDef, bh) / 6, 0, 1) : 0;
  const handlerThreat = threat(bh);

  for (const p of movers) {
    const ob = p.ob;
    if (!ob) continue;
    const d = defByAssign.get(p);
    const tend = effectiveTendencies(p);
    const cutFactor = tendencyFactor(tend.driveRim);
    const screenFactor = tendencyFactor(tend.screen);
    const inside = isInsidePlayer(p);
    const postThreat = tend.postUp >= POST_OFFBALL_PIVOT;
    let home = homeOf.get(p) || spots[ob.spot] || spots[1];
    if (postThreat && (p.offLaneT ?? 0) < 1.2) home = { x: h.x + dir * INSIDE_X, y: ob.spot % 2 ? 15 : 35 };
    const spacingOptions = inside ? insideSpots : perimeterSpots;

    const dec: OffBallDecision = {
      who: p,
      to: { x: home.x, y: home.y },
      candidates: [],
      committed: false,
      cutState: false,
      fillState: false,
      screenState: false,
      rollState: false,
      popState: false,
      tookDriveRelocate: false,
      heldDriving: false,
      heldDwell: false,
      retarget: false,
    };

    // --- cut in progress (committed) ---
    if (ob.state === "cut") {
      dec.committed = true;
      dec.cutState = true;
      dec.to = { x: h.x + dir * 2.5, y: ob.cutY as number };
      reserved.push({ p, point: dec.to, inside: true });
      out.push(dec);
      continue;
    }
    // --- fill in progress (committed) ---
    if (ob.state === "fill") {
      dec.committed = true;
      dec.fillState = true;
      const fillTo = ob.fill || home;
      dec.to = reserveAwareTarget(p, fillTo, spacingOptions, reserved, def, h, inside);
      reserved.push({ p, point: dec.to, inside });
      out.push(dec);
      continue;
    }
    // --- screen in progress (committed) ---
    if (ob.state === "screen") {
      dec.committed = true;
      dec.screenState = true;
      // The screener decides WHERE to plant himself: beside the LIVE on-ball defender
      // (read from this tick's positions), on the side that springs the handler to the
      // more open lane. Not a central spot — tracks the play, never goes stale.
      dec.to = screenAnchor(bh, p, h, onBallDef, def);
      reserved.push({ p, point: dec.to, inside: true });
      out.push(dec);
      continue;
    }
    // --- roll to the rim (committed) — screener dives inside after the pick ---
    if (ob.state === "roll") {
      dec.committed = true;
      dec.rollState = true;
      dec.to = legalInsideHome(p, h, dir);
      reserved.push({ p, point: dec.to, inside: true });
      out.push(dec);
      continue;
    }
    // --- pop beyond the arc (committed) — stretch screener lifts for a three ---
    if (ob.state === "pop") {
      dec.committed = true;
      dec.popState = true;
      dec.to = { x: h.x + dir * POP_OUT_DEPTH, y: 30 };
      reserved.push({ p, point: dec.to, inside: false });
      out.push(dec);
      continue;
    }

    // --- spacing read (the holdSpace target) ---
    // BALL-DRIVEN FORMATION: the default home is the mover's FIXED slot shifted
    // smoothly by the ball position (helios-base getPositions). Every mover's home
    // is the same smooth function of the ball, so the four slide together as a unit
    // when the ball moves (coherent, not four independent spot-hunters). Drive
    // push/lane-clear/dwell below are deviations from this skeleton.
    const formHome = formationHome(home, { x: bh.x, y: bh.y }, h, dir, inside);
    let tgt: Point = formHome;
    let usingFormation = true; // holdSpace base is the ball-driven slot (no spot-hunt)
    if (shouldClearLane(p, h)) {
      tgt = laneClearSpot(p, home, h, dir);
      usingFormation = false;
    } else if (driving) {
      // PUSH/PULL on the drive (principle 1). One coherent per-player rule:
      //   - a mover on the SAME side as the drive lane, near the rim, PUSHES away
      //     to the weak side, clearing the lane the driver is attacking;
      //   - a mover on the FAR side is PULLED to FILL the vacated ball-side gap
      //     (relocate toward the drive's side / corner), so the floor refills as
      //     the drive collapses the help. Applied per-player off the drive
      //     direction → globally coherent movement, no central script.
      const onDriveSide = p.y < 25 === driveSideLow;
      if (onDriveSide && dist(p, h) < DRIVE_PUSH_DEPTH_MAX && !ob.relocatedForDrive && !drivePushUsed) {
        // PUSH: clear to the weak side, away from the drive lane.
        tgt = { x: home.x, y: 50 - home.y };
        usingFormation = false;
        dec.tookDriveRelocate = true;
        drivePushUsed = true; // single push relocation per drive tick
      } else if (
        !onDriveSide &&
        !inside &&
        !isCorner(p) &&
        DRIVE_PULL_ON &&
        dist(p, h) > 21 &&
        dist(bh, h) < DRIVE_PULL_PENETRATION &&
        !ob.relocatedForDrive &&
        !drivePullUsed
      ) {
        // PULL/FILL (the second half of principle 1): once the drive has PENETRATED
        // (handler collapsing the defense near the rim), a weak-side PERIMETER man
        // (a wing/top, not already a corner) lifts to the ball-side CORNER the drive
        // opened — a spaced kick-out spot WELL out of the lane.
        //
        // OFF in this build: in this engine the relocating man drags his defender
        // toward the strong side, where the defense reads it as help and contains
        // the drive — measurably trimming rim finishes for a drive-heavy team
        // (tests/driving.ts floor) without a coordination payoff worth that cost.
        // The PUSH half (clearing the lane) carries the drive-coordination cleanly
        // on its own; the hook stays so PULL can be re-enabled if the help-read is
        // later tuned to not over-commit to a corner lift.
        const cornerY = driveSideLow ? 4 : 46;
        tgt = { x: Math.max(home.x, h.x + dir * 22), y: cornerY };
        usingFormation = false;
        dec.tookDriveRelocate = true;
        drivePullUsed = true;
      } else if (p.target) {
        // already relocated for this drive (or another mover took the slot this
        // tick): hold the current (frozen prior) target while the drive continues.
        dec.heldDriving = true;
        dec.to = p.target;
        reserved.push({ p, point: dec.to, inside });
        out.push(dec);
        continue;
      }
    }

    // DWELL (spacing only): hold the floor-spacing spot for the dwell window, and do
    // not re-score actions during the dwell — a brief settle after each relocation.
    const triggerFired = shouldClearLane(p, h) || justPassed || (driving && !ob.relocatedForDrive);
    if (!driving && !triggerFired && ob.t < SPACE_DWELL_MIN && p.target) {
      dec.heldDwell = true;
      dec.to = p.target;
      reserved.push({ p, point: dec.to, inside });
      out.push(dec);
      continue;
    }

    // holdSpace target. With the ball-driven formation the default is the mover's
    // FIXED slot home (no spot-hunt) — only collision/spacing de-overlap nudges it
    // off the exact slot, so the slot identity stays put and the four slide as a
    // unit. The lane-clear / drive-relocate deviations keep the legacy reserve-aware
    // spot search (they intentionally relocate). When pressured ball-side, lean a
    // touch off the defender (a small live adjustment, not a slot swap).
    // The holdSpace target is the reserve-aware spacing pick anchored on the
    // ball-driven formation home (preferred). reserveAwareTarget keeps the proven
    // spacing separation (and the option fallback that prevents two bigs/leaned
    // slots from stacking). The COHERENCE/CALM no longer comes from suppressing the
    // search — it comes from the band HYSTERESIS below: the chosen home is HELD until
    // the ball crosses into a new band, so it doesn't re-pick every decision.
    if (usingFormation && !driving && d && dist(d, p) < 7) {
      // pressured ball-side: lean a touch off the defender (small live adjustment).
      const away = Math.sign(p.y - d.y) || 1;
      tgt = { x: tgt.x, y: clamp(tgt.y + away * 3.5, 3, 47) };
    } else if (!usingFormation && !driving && !shouldClearLane(p, h) && d && dist(d, p) < 7) {
      const away = Math.sign(p.y - d.y) || 1;
      tgt = { x: home.x, y: clamp(home.y + away * 3.5, 3, 47) };
    }
    // Anchor the PERIMETER movers to their formation slot (the wandering-spacers the
    // ball-driven formation targets) so the four hold a coherent shape and don't
    // hunt the open spot every tick. EXCEPTION: if the slot would CONFLICT with an
    // already-reserved teammate (within the spacing gap), drop the anchor for this
    // pick so the reserve search relocates to a clear option instead of pinning two
    // bodies together — coherence in the common case, spread when it would stack.
    // Bigs always keep the flexible search (their inside slots can collide).
    const slotConflicts = reserved.some((r) => dist(tgt, r.point) < spacingMin(inside, r.inside));
    const anchorSlot = usingFormation && !inside && !slotConflicts;
    const holdTarget = reserveAwareTarget(p, tgt, spacingOptions, reserved, def, h, inside, anchorSlot);
    // DEAD-ZONE (helios dist_thr = ballDist * 0.1, floored): only retarget when the
    // new formation home has moved meaningfully from the current target, so a mover
    // holds his spot through small ball jitter. Combined with the gentle banded slide
    // (the home barely moves within a band) and the existing SPACE_DWELL hold, this
    // keeps movement calm/coherent WITHOUT freezing the offense — the dynamic
    // relocations that create rim attacks still happen on real ball shifts. (A harder
    // band-locked hold was tried and measurably suppressed drives/cuts; the dead-zone
    // is the lighter touch that keeps both coherence and rim pressure.)
    const prior = p.target;
    const ballDist = dist(p, { x: bh.x, y: bh.y });
    const deadZone = usingFormation ? Math.max(FORM_DEADZONE_MIN, ballDist * FORM_DEADZONE_FRAC) : RETARGET_MIN_SHIFT;
    const holdShifts = !prior || dist(holdTarget, prior) >= deadZone;
    const holdApplied: Point = holdShifts || !prior ? holdTarget : prior;
    dec.to = holdApplied;
    dec.retarget = holdShifts; // resolve resets ob.t = 0 only on a real relocation

    // --- SCORE candidate actions (free mover) ---
    // PASS-AND-MOVE / never stand still (principle 2): a perimeter mover who has
    // gone genuinely idle on the WEAK side (settled, away from the ball, ball not
    // driving) takes a small holdSpace penalty so the off-ball four keep flowing.
    // Kept weak-side-only and gentle so it never crowds a strong-side drive lane;
    // the give-and-go (passer cut), lift, push, and corner-fill carry the rest of
    // "don't stand still". Off in this build (see IDLE_HOLD_PENALTY) — the
    // higher-leverage motion rules already keep movement flowing without it; the
    // hook stays so the nudge can be dialed back in if play looks too static.
    const ballSideLow = bh.y < 25;
    const weakSide = (p.y < 25) !== ballSideLow;
    const idle = !driving && !inside && weakSide && ob.state === "space" && ob.t >= IDLE_DWELL_T;
    const idlePenalty = idle ? IDLE_HOLD_PENALTY * motionScale : 0;
    const cands: OffBallCandidate[] = [
      { kind: "holdSpace", util: HOLD_SPACE_BASE - idlePenalty, to: holdApplied },
    ];

    if (!driving && !shouldClearLane(p, h)) {
      const finishW = (p.attr.finishing - 50) * CUT_UTIL_FINISH_W;
      const laneOpen = isLaneClear(p, def, h);
      // backdoor read: tight ball-side denial by my defender + I'm a threat
      const overplayed = d && dist(d, p) < 3.0 && dist(d, h) > dist(p, h) - 1 && threat(p) > 0.45;
      const cutY = overplayed ? (p.y < 25 ? 20 : 30) : p.y < 25 ? 19 : 31;

      // cut: basket / backdoor / give-and-go. Only when no teammate is already
      // cutting (one cutter in the lane at a time, matching the legacy mutex). The
      // pass-and-move (give-and-go on the passer), early-motion, and backdoor reads
      // are scaled UP under the "motion" action (principle 5 — the play biases, it
      // doesn't dictate); "pnr" leaves them at baseline.
      if (!cutCommitted) {
        let cutU =
          CUT_UTIL_BASE +
          (justPassed ? CUT_UTIL_PASS_BONUS * motionScale : 0) +
          earlyClock * CUT_UTIL_EARLY_BONUS * motionScale +
          (overplayed ? CUT_UTIL_OVERPLAY_BONUS : 0) +
          (laneOpen ? CUT_UTIL_LANE_BONUS : 0) +
          finishW +
          (justPassed && p === passer ? GIVEGO_UTIL_BONUS * motionScale : 0);
        cutU *= cutFactor;
        cands.push({ kind: "cut", util: cutU, to: { x: h.x + dir * 2.5, y: cutY }, cutY });
      }

      // NOTE: ball screens are no longer spawned here as a per-tick candidate. The
      // PnR is owned by updateScreenCall() (the shared "call" + a persistent screener
      // intention) so the screener commits ONCE and runs to the pick spot to
      // completion, instead of re-deciding "screen" every tick (which thrashed).

      // lift: weak-side relocation into open space when the ball changes side.
      if (justPassed && p !== passer) {
        const liftTo = reserveAwareTarget(
          p,
          mostOpenSpot(p, spacingOptions, off, def, h),
          spacingOptions,
          reserved,
          def,
          h,
          inside,
        );
        const liftU =
          (LIFT_UTIL_BASE + LIFT_UTIL_BALLMOVE_BONUS * motionScale) * tendencyFactor(tend.pass);
        cands.push({ kind: "lift", util: liftU, to: liftTo });
      }

      // FILL THE VACATED SPOT (principle 4): a perimeter mover near a spot a cutter
      // just vacated is pulled to fill it (relocate into the open spot) so the floor
      // stays balanced — corners filled, formation occupied. Nearest-by-mover-order
      // claims it (one filler per tick); the spacing repulsion breaks any overlap.
      if (!inside && !fillClaimed && vacatedSpots.length > 0) {
        let nearest: Point | null = null;
        let nd = FILL_VACATED_RADIUS;
        for (const v of vacatedSpots) {
          const dd = dist(p, v);
          if (dd < FILL_VACATED_MIN_GAP) continue; // effectively already there
          if (dd < nd) {
            nd = dd;
            nearest = v;
          }
        }
        if (nearest) {
          const fillTo = reserveAwareTarget(p, nearest, spacingOptions, reserved, def, h, inside);
          const fillU = (LIFT_UTIL_BASE + FILL_VACATED_BONUS * motionScale) * tendencyFactor(tend.pass);
          cands.push({ kind: "lift", util: fillU, to: fillTo });
          fillClaimed = true;
        }
      }
    }

    dec.candidates = cands;
    reserved.push({ p, point: dec.to, inside });
    out.push(dec);
  }
  return out;
}

/* ---------- 4) OFF-BALL RESOLVE ----------
   Applies the decideOffBall() output and does the noise + selection + state-machine
   half: for a MID-COMMITMENT mover it advances/expires the commitment (cut→fill→
   space, screen→roll/pop, roll/pop hold) and applies the continuation target; for a
   FREE mover it adds decision NOISE (randn()*OFFBALL_NOISE) to each scored
   candidate, picks the best, COMMITS it (sets ob.state, resets ob.t, applies its
   target). holdSpace wins → stay spacing. The pnr screener is just a mover here:
   his screen carries the PNR_SCREEN_BONUS in decide, and once the pick is set he
   commits to ROLL or POP by the deterministic shouldPop() utility (replacing the old
   chance(G.screenPop) rng + bringup→screen→roll phase FSM). ALL off-ball rng lives
   here, consumed in fixed per-mover order, so the seeded stream stays a port spec.
   Spacing targets are NOT recomputed here (decideOffBall owns them). See
   docs/decide-pipeline-design.md. */
function resolveOffBall(s: Snapshot, offBallIntents: OffBallDecision[]): void {
  const off = offTeam(),
    def = defTeam(),
    h = hoop();
  const dir = G.attackHoop === "R" ? -1 : 1;
  const sp0 = spotsFor(G.attackHoop);
  const bh = G.ball.holder;
  // while the ball is in flight (pass or shot) nobody has it: just hold spacing
  if (!bh) {
    off.forEach((p, i) => (p.target = sp0[i]));
    return;
  }

  // ----- apply off-ball decisions: commitment lifecycle + noise/select/commit -----
  // For each mover (fixed order): if mid-commitment, advance/expire its cut/fill/
  // screen and apply the continuation target. Else add noise to the scored
  // candidates, pick the winner, and COMMIT it (set ob.state, reset ob.t, apply
  // target). holdSpace winning means stay spacing. All off-ball rng (the noise)
  // lives here, consumed in fixed per-mover order.
  {
    const { perimeterSpots, homeOf, spots, movers, pnrScreener } = offBallSetup(s, bh);
    const homeForMover = (p: Player): Point => {
      const ob = p.ob;
      let home = homeOf.get(p) || (ob ? spots[ob.spot] : spots[1]) || spots[1];
      const tend = effectiveTendencies(p);
      if (tend.postUp >= POST_OFFBALL_PIVOT && (p.offLaneT ?? 0) < 1.2)
        home = { x: h.x + dir * INSIDE_X, y: (ob?.spot ?? 0) % 2 ? 15 : 35 };
      return home;
    };
    // mutual exclusion: at most one cutter / one screener at a time. Seed from the
    // snapshot states (committed movers count), then grow as new commitments fire.
    let cutCommitted = movers.some((p) => p.ob?.state === "cut");
    let screenCommitted = movers.some((p) => p.ob?.state === "screen");
    for (const dec of offBallIntents) {
      const p = dec.who;
      const ob = p.ob;
      if (!ob) continue;
      ob.t += DT;
      const inside = isInsidePlayer(p);
      p.dbgIntent = ob.state;

      // --- cut in progress (committed) ---
      if (dec.cutState) {
        // Don't cut INTO a live drive: a committed cutter on the DRIVE SIDE (in the
        // lane the handler is attacking) clears OUT to the weak-side corner instead of
        // diving into the congestion and dragging his man to the ball. A WEAK-SIDE
        // cutter keeps going — he's the dunker/dump-off target on the help-side, a
        // real rim finish, not congestion.
        if (G.driving && (p.y < 25) === (bh.y < 25)) {
          const corner = { x: clamp(h.x + dir * 3, 3, COURT_L - 3), y: bh.y < 25 ? 46 : 4 };
          p.target = corner;
          ob.state = "fill";
          ob.t = 0;
          ob.fill = corner;
          continue;
        }
        p.target = dec.to;
        cutCommitted = true;
        if (dist(p, { x: h.x, y: 25 }) < 5.5 || ob.t > 2.0) {
          ob.state = "fill";
          ob.t = 0;
          ob.fill = inside ? homeForMover(p) : mostOpenSpot(p, perimeterSpots, off, def, h);
        }
        continue;
      }
      // --- fill in progress (committed) ---
      if (dec.fillState) {
        p.target = dec.to;
        ob.fill = dec.to;
        if (dist(p, p.target) < 3 || ob.t > 2.6) {
          ob.state = "space";
          ob.t = 0;
        }
        continue;
      }
      // --- screen in progress (committed) ---
      if (dec.screenState) {
        p.target = dec.to;
        ob.screenTarget = dec.to; // his live anchor this tick (activeScreen + set detection read it)
        // never let the pick camp him in the paint — clear out before a 3-sec call.
        if (shouldClearLane(p, h)) {
          p.target = laneClearSpot(p, p.target, h, dir);
          p.dbgIntent = "laneclear";
        }
        screenCommitted = true;
        const isPnr = p === pnrScreener;
        // Roll/pop fires ONLY when the screen was actually SET (physical contact
        // with the on-ball defender — ob.screenSet, written by applyScreenContact)
        // AND the handler ENGAGED it (drove off it / pulled ahead — ob.screenUsed).
        // No more firing on the bare global G.driving or a bare timer. If the
        // handler never uses the pick, the screen expires (SCREEN_HOLD_EXPIRE) and
        // the screener RELOCATES/spaces rather than rolling into nothing.
        const setAndUsed = !!ob.screenSet && !!ob.screenUsed;
        if (setAndUsed) {
          // CONSUME the set+used into ONE roll/pop/cut — clear the flags so the
          // screener can't immediately re-trigger another roll off the same screen
          // (one roll/pop per pick). A new pick must be set + used to roll again.
          ob.screenSet = false;
          ob.screenUsed = false;
          if (isPnr) {
            const pop = shouldPop(p, def, h, dir);
            ob.state = pop ? "pop" : "roll";
            ob.t = 0;
            ob.screenTarget = null;
          } else {
            ob.state = "cut";
            ob.t = 0;
            ob.cutY = bh.y < 25 ? 19 : 31;
            ob.screenTarget = null;
            cutCommitted = true;
          }
        } else if (G.screenCall?.screener !== p && ob.t > screenHoldExpire(p)) {
          // unused pick with NO active call (defensive): give up and space out. A
          // CALLED screener is never expired here — updateScreenCall owns the
          // lifecycle (its SCREEN_CALL_EXPIRE), so resolveOffBall doesn't fight it
          // by yanking him to "space" mid-approach (the bug that killed set-rate).
          ob.state = "space";
          ob.t = 0;
          ob.screenTarget = null;
        }
        continue;
      }
      // --- roll in progress (committed): screener dives to the rim ---
      if (dec.rollState) {
        p.target = dec.to;
        p.dbgIntent = "pnr-roll";
        // Re-evaluate the roll (the cut logic's sibling): if he's diving into the lane
        // the ball-handler is ATTACKING, peel to the OPEN side of the rim (opposite his
        // attack) rather than running into him. He stays a rim/dump-off threat — unlike
        // a cutter who vacates to the corner — just on the side that doesn't clog.
        if (G.driving && (p.y < 25) === (bh.y < 25)) {
          p.target = { x: h.x + dir * 3, y: bh.y < 25 ? 32 : 18 };
          p.dbgIntent = "roll-open";
        }
        if (shouldClearLane(p, h)) {
          p.target = laneClearSpot(p, p.target, h, dir);
          p.dbgIntent = "laneclear";
        }
        p.target = clampInteriorTarget(p.target);
        // The roller READS when the dive is spent (no fixed timer/distance): while his
        // ball-handler is attacking the rim the dump-off is live, so he keeps diving; once
        // the handler is no longer attacking AND he's dived past him toward the basket, the
        // play has moved on — he stops rolling and his normal off-ball decider takes over
        // (post up / sit in the dunker / relocate) per his own read and attributes.
        if (!G.driving && dist(p, h) < dist(bh, h)) {
          ob.state = "space";
          ob.t = 0;
        }
        continue;
      }
      // --- pop in progress (committed): screener lifts beyond the arc ---
      if (dec.popState) {
        p.target = dec.to;
        p.dbgIntent = "pnr-pop";
        // he spaced out for the attack; once the handler is no longer attacking he reads
        // the action as over and becomes a normal spot-up shooter (his decider resumes).
        if (!G.driving && dist(p, h) > dist(bh, h)) {
          ob.state = "space";
          ob.t = 0;
        }
        continue;
      }

      // --- free mover: dbg + drive-relocation bookkeeping ---
      // reset drive-relocation flag when driving ends
      if (!s.driving && ob.relocatedForDrive) ob.relocatedForDrive = false;
      p.dbgIntent = shouldClearLane(p, h)
        ? "laneclear"
        : effectiveTendencies(p).postUp >= POST_OFFBALL_PIVOT
          ? "post"
          : inside
            ? "space-inside"
            : "space-perim";

      // apply the decided spacing target; a committed action below overrides it.
      p.target = dec.to;

      // driving-hold: decide held the prior target; no scoring, no ob.t reset.
      if (dec.heldDriving) continue;
      // driving-relocate: decide moved weak-side; mark the edge-gated flag.
      if (dec.tookDriveRelocate) ob.relocatedForDrive = true;
      // dwell-hold: settle the spot, no scoring this tick.
      if (dec.heldDwell) continue;

      // noise + select among the scored candidates.
      let best: OffBallCandidate | null = null;
      let bestU = -Infinity;
      for (const c of dec.candidates) {
        // a cut/screen already taken this tick by an earlier mover is unavailable.
        if (c.kind === "cut" && cutCommitted) continue;
        if (c.kind === "screen" && (screenCommitted || cutCommitted)) continue;
        const u = c.util + randn() * OFFBALL_NOISE;
        if (u > bestU) {
          bestU = u;
          best = c;
        }
      }

      if (best && best.kind === "cut") {
        ob.state = "cut";
        ob.t = 0;
        ob.cutY = best.cutY ?? (p.y < 25 ? 19 : 31);
        p.target = { x: h.x + dir * 2.5, y: ob.cutY };
        cutCommitted = true;
        continue;
      }
      if (best && best.kind === "screen") {
        ob.state = "screen";
        ob.t = 0;
        ob.screenTarget = best.screenTo ?? best.to;
        ob.screenedThisPoss = true; // pnr macro-intent re-screen bonus spent for the possession
        ob.screenSet = false; // physical contact not yet made (applyScreenContact sets it)
        ob.screenUsed = false; // handler hasn't engaged the pick yet
        p.target = best.to;
        screenCommitted = true;
        continue;
      }
      if (best && best.kind === "lift") {
        ob.state = "fill";
        ob.t = 0;
        ob.fill = best.to;
        p.target = best.to;
        continue;
      }

      // holdSpace won (or no candidate): stay spacing. Reset the dwell timer iff a
      // real relocation occurred this tick.
      if (dec.retarget) ob.t = 0;
    }
  }
}

/* Classifies an off-ball player as an INSIDE (big) role vs a perimeter shooter.
   A low-three OR high-postUp player operates near the rim; everyone else spaces
   the floor. Drives inside-vs-perimeter spot assignment in offBallMove. */
export function isInsidePlayer(p: Player): boolean {
  // Use the player's INTRINSIC (base) tendencies for his floor-spacing role — a
  // perimeter player coached to limited shot-freedom shouldn't morph into an
  // inside player and abandon the arc; coaching changes WHAT he does, not his
  // archetype/where he spaces.
  const t = tendenciesOf(p);
  return t.shootThree < BIG_SHOOT_THREE_MAX || t.postUp >= BIG_POST_PIVOT;
}

function spacingAwareness(p: Player): number {
  // IQ doubles as offensive awareness until a dedicated trait exists.
  return clamp((p.attr.iq - 35) / 55, 0.35, 1.15);
}

function spacingMin(aInside: boolean, bInside: boolean): number {
  if (aInside && bInside) return TARGET_MIN_INTERIOR_DIST;
  if (!aInside && !bInside) return TARGET_MIN_PERIMETER_DIST;
  return TARGET_MIN_MIXED_DIST;
}

function highPostBand(pt: Point, h: Point): boolean {
  const depth = Math.abs(pt.x - h.x);
  return depth >= HIGH_POST_MIN_DEPTH && depth <= HIGH_POST_MAX_DEPTH && pt.y >= HIGH_POST_MIN_Y && pt.y <= HIGH_POST_MAX_Y;
}

function paintBand(pt: Point, h: Point): boolean {
  return Math.abs(pt.x - h.x) <= 13.75 && pt.y >= HIGH_POST_MIN_Y && pt.y <= HIGH_POST_MAX_Y;
}

function shouldClearLane(p: Player, h: Point): boolean {
  if (!paintBand(p, h)) return false;
  const awareness = spacingAwareness(p);
  const warnAt = LANE_CLEAR_WARN_T + (1.15 - awareness) * LANE_CLEAR_LOW_IQ_EXTRA_T;
  return (p.offLaneT ?? 0) >= warnAt;
}

function laneClearSpot(p: Player, home: Point, h: Point, dir: number): Point {
  const side = p.y < 25 ? -1 : 1;
  return { x: Math.max(home.x, h.x + dir * 14.5), y: side < 0 ? 13 : 37 };
}

/* Roll-vs-pop UTILITY decision for the pnr screener once the screen is set
   (replaces the old chance(G.screenPop) rng). DETERMINISTIC: pop utility is built
   from the screener's three RATING, his (effective) shootThree tendency, and whether
   the pop spot is open; roll has a flat baseline and wins for non-shooters. Returns
   true to POP (lift beyond the arc), false to ROLL (dive to the rim). Reads only
   frozen ratings/tendencies/geometry — no rng. */
function shouldPop(screener: Player, def: Player[], h: Point, dir: number): boolean {
  const tend = effectiveTendencies(screener);
  // a screener who can't shoot it always rolls (gate matches the legacy canPop)
  if (screener.attr.three < POP_THREE_RATING || tend.shootThree < POP_THREE_TEND) return false;
  const popSpot = { x: h.x + dir * POP_OUT_DEPTH, y: 30 };
  let popOpen = true;
  for (const d of def) {
    if (dist(d, popSpot) < POP_OPEN_RADIUS) {
      popOpen = false;
      break;
    }
  }
  const popU =
    (screener.attr.three - POP_RATING_PIVOT) * POP_RATING_SLOPE +
    (tend.shootThree - POP_THREE_TEND) * POP_TEND_SLOPE +
    (popOpen ? POP_OPEN_BONUS : 0);
  return popU > ROLL_BASE_UTIL;
}

function legalInsideHome(p: Player, h: Point, dir: number): Point {
  const side = (p.ob?.spot ?? 0) % 2 === 0 ? 1 : -1;
  const depth = (p.ob?.spot ?? 0) % 3 === 0 ? DUNKER_X : INSIDE_SHORT_X;
  return { x: h.x + dir * depth, y: side < 0 ? 13 : 37 };
}

function clampTarget(pt: Point): Point {
  return { x: clamp(pt.x, 3, COURT_L - 3), y: clamp(pt.y, 3, 47) };
}

function clampInteriorTarget(pt: Point): Point {
  return { x: clamp(pt.x, 3, COURT_L - 3), y: clamp(pt.y, 8, 42) };
}

function dedupeSpots(spots: Point[]): Point[] {
  const out: Point[] = [];
  for (const s of spots) {
    if (!out.some((o) => Math.abs(o.x - s.x) < 0.1 && Math.abs(o.y - s.y) < 0.1)) out.push(s);
  }
  return out;
}

function targetScore(
  p: Player,
  candidate: Point,
  preferred: Point,
  reserved: ReservedTarget[],
  def: Player[],
  h: Point,
  inside: boolean,
  anchor = false,
): number {
  const awareness = spacingAwareness(p);
  let nearestDef = 16;
  for (const d of def) nearestDef = Math.min(nearestDef, dist(d, candidate));

  // ANCHOR (ball-driven formation): the slot home strongly dominates — the option
  // set is only a fallback for a genuine spacing conflict, not a per-tick open-spot
  // hunt. So with anchor on, deviating from the preferred slot is heavily penalized
  // and openness barely matters; the four hold their slots and slide as a unit.
  const openW = anchor ? 0.28 : 0.35;
  const prefW = anchor ? 1.05 : 0.75;
  let score = nearestDef * openW - dist(candidate, preferred) * prefW;
  score += p.target ? -dist(candidate, p.target) * 0.4 : 0;
  for (const r of reserved) {
    const gap = spacingMin(inside, r.inside);
    const d = dist(candidate, r.point);
    if (d < gap) score -= (gap - d) * (inside && r.inside ? 7 : 10) * awareness;
    if (d < 2.5) score -= 90 * awareness;
    if (highPostBand(candidate, h) && highPostBand(r.point, h)) score -= 55 * awareness;
  }
  return score;
}

function reserveAwareTarget(
  p: Player,
  preferred: Point,
  options: Point[],
  reserved: ReservedTarget[],
  def: Player[],
  h: Point,
  inside: boolean,
  anchor = false,
): Point {
  const candidates = dedupeSpots([preferred, ...options]);
  let best = candidates[0],
    bestScore = -1e9;
  for (const c of candidates) {
    const score = targetScore(p, c, preferred, reserved, def, h, inside, anchor);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }

  let out: Point = { x: best.x, y: best.y };
  const awareness = spacingAwareness(p);
  for (const r of reserved) {
    const gap = spacingMin(inside, r.inside);
    const d = dist(out, r.point);
    if (d >= gap) continue;
    let ax = out.x - r.point.x,
      ay = out.y - r.point.y,
      mag = Math.hypot(ax, ay);
    if (mag < 0.1) {
      ax = 0;
      ay = out.y < 8 ? 1 : out.y > 42 ? -1 : (p.ob?.spot ?? 0) % 2 === 0 ? 1 : -1;
      mag = 1;
    }
    const push = (gap - d) * awareness;
    out = { x: out.x + (ax / mag) * push, y: out.y + (ay / mag) * push };
  }
  if (highPostBand(out, h) && reserved.some((r) => highPostBand(r.point, h))) {
    const side = out.y < 25 ? -1 : 1;
    out.y += side * 5 * awareness;
  }
  out = inside ? clampInteriorTarget(out) : clampTarget(out);
  if (inside) {
    for (const r of reserved) {
      if (dist(out, r.point) >= spacingMin(inside, r.inside)) continue;
      out.y = out.y < 25 ? 37 : 13;
      out = clampInteriorTarget(out);
      break;
    }
  }
  return out;
}

function mostOpenSpot(p: Player, spots: Point[], off: Player[], def: Player[], h: Point): Point {
  let best = spots[spots.length - 1],
    bs = -1e9;
  for (const s of spots) {
    let minDefDist = 1e9;
    for (const d of def) minDefDist = Math.min(minDefDist, dist(d, s));
    const openness = clamp(minDefDist / 20, 0, 1);

    const distToHoop = dist(s, h);
    let shotValue: number;
    if (distToHoop > 22 && (s.y < 8 || s.y > 42)) shotValue = 0.95;
    else if (distToHoop > 22) shotValue = 0.85;
    else if (distToHoop < 8) shotValue = 0.75;
    else shotValue = 0.4;

    let occ = false;
    for (const o of off) {
      if (o !== p && dist(o, s) < 4) occ = true;
    }
    const score = 0.6 * openness + 0.4 * shotValue - (occ ? 0.4 : 0);
    if (score > bs) {
      bs = score;
      best = s;
    }
  }
  return best;
}

function startPass(from: Player, to: Player): void {
  from.hasBall = false;
  G.ball.state = "pass";
  G.ball.holder = null;
  G.ball.target = to;
  G.ball.flight = 0;
  G.ball.from = from;
  // Ball travels at ~31 ft/s (~21 mph) — a chest pass still clearly outpaces a
  // sprinting defender (top ~24 ft/s) but reads at a watchable, announceable pace
  // rather than a blur. 0.32 ticks/ft → dist/(0.32*0.1) ≈ 31 ft/s; min 0.3s.
  G.ball.passDur = Math.max(3, Math.round(dist(from, to) * 0.28));
  const def = defTeam();
  const routeRisk = passRouteRisk(from, to, hoop());

  // bad-pass / handling turnover: the pass itself is errant or deflected.
  // Scales with the passer's (low) pass attribute and with defensive pressure
  // on the receiver. On a turnover the ball goes to the nearest recovering
  // defender; if a defender is close enough to the errant ball, credit a steal.
  {
    let recvPressure = 0;
    for (const d of def) {
      if (dist(d, to) < BAD_PASS_RECV_RADIUS) recvPressure = BAD_PASS_RECV_PRESSURE;
    }
    const badP = clamp(
      (BAD_PASS_BASE +
        Math.max(0, (70 - from.attr.pass) * BAD_PASS_PASS_SLOPE) +
        recvPressure +
        routeRisk * (BAD_PASS_ROUTE_BASE + Math.max(0, 70 - from.attr.pass) * BAD_PASS_ROUTE_PASS_SLOPE)) *
        simTunables().turnovers.badPassScale,
      0,
      BAD_PASS_CAP,
    );
    if (chance(badP)) {
      from.stats.tov++;
      recordTO("badpass", from, dist(from, hoop()));
      // nearest defender to the intended target recovers the loose ball
      let recover: Player | null = null,
        rd = 1e9,
        creditedSteal = false;
      for (const d of def) {
        const dd = dist(d, to);
        if (dd < rd) {
          rd = dd;
          recover = d;
        }
      }
      if (recover && rd < BAD_PASS_CLAIM_RADIUS) {
        const stealChance = clamp(
          BAD_PASS_STEAL_BASE +
            (effectiveTendencies(recover).gambleSteal - BAD_PASS_STEAL_GAMBLE_PIVOT) * BAD_PASS_STEAL_GAMBLE_SLOPE,
          0,
          1,
        );
        if (chance(stealChance)) {
          recover.stats.stl++;
          creditedSteal = true;
          logEv(`${recover.name} picks off the pass — steal!`, "to");
        } else {
          logEv(`${from.name} throws it away — turnover`, "to");
        }
      } else {
        logEv(`${from.name} throws it away — turnover`, "to");
      }
      if (recover) beginLiveTransition(recover, creditedSteal);
      return;
    }
  }

  // passing-lane steal: only a defender genuinely sitting in the passing lane,
  // not near either endpoint (that would be normal on-ball/catch defense).
  for (const d of def) {
    const ld = distToSeg(d, from, to);
    if (ld < 2.0 && dist(d, from) > 4 && dist(d, to) > 4) {
      const sp =
        clamp(
          (LANE_STEAL_BASE +
            (d.attr.steal - 70) * LANE_STEAL_STEAL_SLOPE -
            (from.attr.pass - 70) * LANE_STEAL_PASS_SLOPE +
            routeRisk * LANE_STEAL_ROUTE_RISK) *
            simTunables().turnovers.laneStealScale,
          0,
          LANE_STEAL_CAP,
        ) * tendencyFactor(effectiveTendencies(d).gambleSteal);
      if (chance(sp)) {
        d.stats.stl++;
        from.stats.tov++;
        recordTO("lane", from, dist(from, hoop()));
        logEv(`${d.name} jumps the passing lane — steal!`, "to");
        beginLiveTransition(d, true);
        return;
      }
    }
  }

  // Give the ball a heading + speed aimed at the receiver. Each tick of flight
  // the ball re-aims toward the receiver's LIVE position with a capped turn rate
  // (see possession.ts), so the path stays near-straight but homes onto a moving
  // receiver and ends exactly on them — a clean in-stride catch, no receiver
  // override (the receiver keeps their own motion), so gameplay is unchanged.
  const dx0 = to.x - from.x;
  const dy0 = to.y - from.y;
  const d0 = dist(from, to) || 1;
  const travelSec = (G.ball.passDur as number) * DT;
  G.ball.hx = dx0 / d0;
  G.ball.hy = dy0 / d0;
  G.ball.bspeed = d0 / travelSec;
  G.ball.catchPoint = null;
}

/* ==================================================================
   DECIDE PIPELINE — pure offensive deciders (ADDITIVE)

   These mirror the scoring in `offenseDecide()` (ball-handler block) and the
   off-ball target geometry in `offBallMove()` / `runAction()` / the `p.ob` state
   machine, but as PURE functions: they only read live/frozen state and RETURN
   Intents. They never mutate `G`, never consume rng (no chance/rnd/rng/randn),
   never set `.target`/`.hasBall`/ball state, never write stats, and never call
   any executor (startPass/attemptShot/postUp/beginLiveTransition/recordTO/etc.).

   Side effects, rng draws, and state transitions deferred to RESOLVE are
   documented in the RESOLVE SPEC delivered alongside this code.

   During the DECIDE phase the snapshot positions equal the live `Player`
   positions (the snapshot is taken at tick start, before any mutation), so the
   existing pure helpers — which read live `Player.x/.y` via `view.ref` — return
   the same values they would against the snapshot. We reuse them rather than
   re-deriving geometry, keeping behavior identical to `offenseDecide()`.
   ================================================================== */

/* ---------- decideOnBall ----------
   Replicates the shoot / drive / pass / post-up utility SCORING of the
   ball-handler block (offense.ts) and returns the scored candidates as a
   BallDecision. Returns null when there is no ball-handler.

   This decider is rng-free and side-effect-free. It computes the four PRE-NOISE
   utilities plus all context RESOLVE needs to add noise, select the winner, run
   the drive-cutoff rolls, and execute. What is INTENTIONALLY DEFERRED to RESOLVE
   (see RESOLVE SPEC / resolveOffense below):
   - the on-ball strip/turnover roll (chance(tovP)),
   - the rng decision noise (randn()*noise on each utility),
   - the per-drive cutoff matchup roll (G.driveBeaten = !chance(...)) and the
     cutoff turnover roll (chance(toP)) — and the deterministic driveU=-1 it sets,
   - the wantHold computation and HOLD probe execution (holdAndProbe),
   - the selection precedence and all execution side effects (ball.state,
     G.driving set/clear, startPass, attemptShot, postUp, putbackBy consume, etc.).

   Putback (G.putbackBy READ here for scoring): the live code applies the shoot
   bonus / pass halving BEFORE the noise, so it belongs in the pre-noise scores
   returned here. The CONSUMPTION (G.putbackBy = null) is a RESOLVE effect. */
export function decideOnBall(s: Snapshot): BallDecision | null {
  const bhv = ballHolderViewLocal(s);
  if (!bhv) return null;
  const bh = bhv.ref;
  const off = s.off.map((v) => v.ref);
  const def = s.def.map((v) => v.ref);
  const h = s.hoop;
  const tac = s.tacOff;
  const tuning = simTunables();

  const dh = dist(bh, h);
  const type = shotTypeFor(dh);
  const contest = contestOf(bh, def);
  const open = clamp(1 - contest, 0, 1);
  const pts = type === "three" ? 3 : 2;
  const mp = makeProb(bh, type, contest);
  const ev = mp * pts;

  const selM = (() => {
    const sel = tac.shotSel;
    if (type === "three") return sel === "three" ? 1.4 : sel === "rim" ? 0.55 : 1;
    if (type === "rim" || type === "close") return sel === "rim" ? 1.4 : sel === "three" ? 0.7 : 1;
    return sel === "three" ? 0.7 : 1;
  })();
  const urg = s.shotClock < 10 ? (10 - s.shotClock) / 10 : 0;

  const tendencies = effectiveTendencies(bh);
  const shootTend =
    type === "three" ? tendencies.shootThree : type === "mid" ? tendencies.shootMid : tendencies.driveRim;
  let shootU = ev * selM * (0.35 + 0.65 * open) + urg * 2.4;
  if (type === "three") {
    shootU *= shootTendMult(shootTend) * THREE_UTILITY_MULT * tuning.decisions.threeUtilityScale;
    const reluctance = clamp((shootTend - 26) / 18, 0, 1) * clamp((64 - shootTend) / 13, 0, 1);
    const t3 = bh.attr.three;
    const capable = clamp((t3 - 42) / 16, 0, 1) * clamp((78 - t3) / 16, 0, 1);
    shootU += THREE_UTILITY_FLOOR * tuning.decisions.threeUtilityScale * open * reluctance * capable;
  } else {
    shootU *= tendencyFactor(shootTend);
  }

  const clockFrac = clamp(s.shotClock / 24, 0, 1);
  const paceAdj = tac.pace === "fast" ? -PACE_PATIENCE : tac.pace === "slow" ? PACE_PATIENCE : 0;
  const patience = clamp(BASE_PATIENCE + paceAdj, 0, 1) * clockFrac;
  shootU *= 1 - patience * (PATIENCE_OPEN_FLOOR + (1 - PATIENCE_OPEN_FLOOR) * (1 - open));

  const wideOpen = bh.catchShoot || contest < OPEN_CATCH_CONTEST;
  if (wideOpen && open > 0.45) {
    shootU += CATCH_SHOOT_SHOOT_BONUS * open;
  }

  const onBall = def.find((d) => d.assign === bh) || nearestDef(bh, def).d;
  const laneBlock = rimHelp(bh, def, h);
  let driveU = -1;
  if (dh > DRIVE_BASE_DIST_MIN) {
    const defPerimD = onBall ? onBall.attr.perimD : 50;
    const defSpeed = onBall ? onBall.attr.speed : 50;
    const defIq = onBall ? onBall.attr.iq : 70;
    const handleEdge = (handleOf(bh) - defPerimD) * DRIVE_HANDLE_SLOPE;
    const speedEdge = (bh.attr.speed - defSpeed) * DRIVE_SPEED_SLOPE;
    const iqBonus = Math.max(0, DRIVE_IQ_PIVOT - defIq) * DRIVE_IQ_SLOPE;

    let lagBonus = 0;
    if (onBall && onBall.target) {
      const defLag = dist(onBall.target, bh);
      if (defLag > DRIVE_LAG_DIST_THRESHOLD) lagBonus = DRIVE_LAG_BONUS;
    }

    let tightBonus = 0;
    if (tac.pressure === "tight" && handleOf(bh) >= DRIVE_TIGHT_HANDLE_FLOOR) {
      tightBonus = DRIVE_TIGHT_BONUS;
    }

    // The PnR drive edge is now PHYSICAL: a set screen hangs up the on-ball
    // defender (movement.ts resolveScreenContact), so he lags and the proximity-
    // keyed contest/lag math rewards the drive on its own. A small residual screen
    // bonus nudges the handler to attack OFF the pick (commit to the action the set
    // play exists for) rather than just probe, but the bulk of the advantage comes
    // from the real separation — no magic bonus standing in for the body.
    const offScreenBonus = (() => {
      if (!onBall) return 0;
      for (const o of off) {
        if (o === bh) continue;
        // attack DOWNHILL off a set pick: the bonus persists through the screener's
        // screen AND its immediate roll/pop (the live action) so the handler keeps
        // pressing to the rim rather than settling once the pick frees him — this is
        // what keeps the PnR a rim threat against a dropping big.
        const st = o.ob?.state;
        if ((st === "screen" || st === "roll" || st === "pop") && o.ob?.screenSet)
          return DRIVE_SCREEN_BONUS;
      }
      return 0;
    })();

    const continuationBonus = s.driving ? DRIVE_CONTINUATION_BONUS : 0;
    // Coming off a SET pick, the handler attacks DOWNHILL: his man's been screened, so
    // the lane congestion (the roller + its defender) is a READ/dump-off, not a wall.
    // Discount laneBlock's bite so a realistic on-the-defender screen springs a rim
    // attack instead of reading as walled-off. The flat offScreenBonus adds momentum.
    const laneBite = offScreenBonus > 0 ? laneBlock * 0.7 * SCREEN_LANE_DISCOUNT : laneBlock * 0.7;
    driveU = (clamp(handleEdge + speedEdge, -0.3, 0.65) + 0.68 + iqBonus + lagBonus + tightBonus + continuationBonus)
      * (1 - laneBite)
      + offScreenBonus;
  }

  if (dh > OPEN_LANE_MIN_DIST) {
    const laneOpen = isLaneClear(bh, def, h);
    if (laneOpen) driveU += OPEN_LANE_BONUS;
  }

  if (tac.shotSel === "rim") driveU += 0.25;
  if (tac.shotSel === "three") driveU -= 0.2;
  driveU *= tendencyFactor(tendencies.driveRim) * tuning.decisions.driveUtilityScale;

  if (dh > DRIVE_BASE_DIST_MIN) driveU += urg * DRIVE_URGENCY;

  const giveUpBig = isInsidePlayer(bh) && handleOf(bh) < BIG_GIVEUP_HANDLE && dh > BIG_GIVEUP_DEPTH;
  if (giveUpBig) driveU *= BIG_DRIVE_SUPPRESS;

  const onBallBeaten = onBall
    ? dist(onBall, h) > dh - LAYUP_BEATEN_BEHIND || dist(onBall, bh) > LAYUP_BEATEN_GAP
    : true;
  const cleanToRim = s.driving && onBallBeaten && laneWallCount(bh, def, h) < 2;

  const driveKickActive = s.driving && dh < DRIVE_KICK_MIN_HANDLER_DIST
    && !cleanToRim
    && helpCommittedToDriver(bh, def, h);
  const kickPassBonus = driveKickActive
    ? DRIVE_KICK_OPEN_BONUS * clamp((bh.attr.pass - 50) * DRIVE_KICK_PASS_SLOPE + 1, 0.7, 1.5)
    : 0;

  let bestPass: Player | null = null,
    bestPU = -1;
  for (const t of off) {
    if (t === bh) continue;
    const tc = contestOf(t, def),
      to = 1 - tc;
    const td = dist(t, h),
      tt = shotTypeFor(td);
    const tev = makeProb(t, tt, tc) * (tt === "three" ? 3 : 2);
    const advance = td < dh - 2 ? 0.3 : 0;

    let kickBonus = 0;
    if (driveKickActive) {
      const tDef = def.find((d) => d.assign === t);
      if (tDef && isHelping(tDef, bh, h)) kickBonus = kickPassBonus;
    }
    if (t.catchShoot) kickBonus = Math.max(kickBonus, CATCH_SHOOT_PASS_BONUS);

    const postFeedBonus = postFeedValue(t, def, h);
    const handoffBonus = giveUpBig && handleOf(t) >= BIG_GIVEUP_HANDLE ? HANDOFF_PASS_BONUS : 0;

    // POCKET PASS TO THE ROLLER: a screener diving to the rim off a set pick is the
    // PnR's primary read — feed him for the rim attempt (lob/dump-off) when his dive
    // is reasonably open. Scaled toward the rim (a deep roll, not a high pick-up).
    let rollFeedBonus = 0;
    if (t.ob?.state === "roll" && td < ROLL_FEED_RANGE) {
      // a diving roller is a feed even when partially covered (lob/dump-off over the
      // drop); openness scales it but a contested roll still beats a settle.
      rollFeedBonus = ROLL_FEED_BONUS * clamp(0.5 + to, 0.5, 1.5);
    }

    const pu = to * 0.9 + tev * 0.5 + advance + kickBonus + postFeedBonus + handoffBonus + rollFeedBonus
      - passSelectionPenalty(bh, t, h);
    if (pu > bestPU) {
      bestPU = pu;
      bestPass = t;
    }
  }
  const passBias = s.possClock < 6 ? 0.5 : 0.1;
  let passU = (bestPU + passBias) * tendencyFactor(tendencies.pass) * tuning.decisions.passUtilityScale;

  const postDef = onBall;
  let postEdge = 0;
  let postU = -1;
  if (postDef && dh <= POST_RANGE && tendencies.postUp >= POST_MIN_TEND) {
    postEdge = postOffenseRating(bh) - postDefenseRating(postDef);
    if (postEdge > POST_MIN_EDGE) {
      postU =
        (POST_BASE_UTIL + clamp(postEdge, 0, POST_EDGE_CAP) * POST_EDGE_UTIL_MULT) *
        tendencyFactor(tendencies.postUp) *
        POST_TEND_MULT;
    }
  }

  // Beaten on-ball man at attack range → the handler attacks the rim. How willing he is
  // to FINISH THROUGH HELP scales with how aggressively he attacks the rim (driveRim):
  // an aggressive attacker goes up through a body (and through 2 walling defenders); an
  // average player gates at the old threshold and kicks more. Keying this on the trait
  // (rather than buffing it globally) keeps leaguewide rim conversion at baseline while
  // letting a rim-attacking team actually convert drives into rim attempts.
  const aggro = clamp((effectiveTendencies(bh).driveRim - 50) / 30, 0, 1); // 0 at ≤50, 1 at ≥80
  const wallTol = aggro >= 0.5 ? 3 : 2; // a determined attacker drives into 2 defenders
  if (onBallBeaten && dh < LAYUP_ATTACK_DIST && laneWallCount(bh, def, h) < wallTol) {
    const help = rimHelp(bh, def, h);
    if (dh > DRIVE_BASE_DIST_MIN) {
      driveU += LAYUP_DRIVE_BONUS * clamp(1 - help * 0.5, 0.4, 1);
    } else {
      shootU += LAYUP_FINISH_BONUS * clamp(1 - help * (0.6 - 0.2 * aggro), 0.3 + 0.2 * aggro, 1);
      passU *= clamp(0.4 + help * 0.5, 0.4, 0.85 - 0.15 * aggro);
    }
  }

  // Drive cutoff is RESOLVE's job in full: the on-ball beat-your-man roll
  // (G.driveBeaten), the help-cutoff containment test, the deterministic
  // driveU=-1 it sets, and the cutoff turnover/charge/travel rolls all happen
  // after the noise add, in resolveOffense. DECIDE leaves driveU untouched.

  if (wideOpen) {
    driveU += OPEN_CATCH_DRIVE_BONUS;
    passU *= OPEN_CATCH_RESET_PENALTY;
  }

  // Putback (offense.ts): the shoot bonus / pass halving apply BEFORE the noise,
  // so they belong in the returned pre-noise scores. The CONSUMPTION
  // (G.putbackBy = null) is a RESOLVE effect.
  if (G.putbackBy === bh && dh < PUTBACK_RANGE) {
    shootU += PUTBACK_SHOOT_BONUS;
    passU *= 0.5;
  }

  // The handler's OWN read on getting a ball screen: he calls for one only when he's
  // CONTAINED — running a PnR with no open shot, no open driving lane, and no good pass.
  // Keyed on OPENNESS (lane clear / open shot), NOT drive ability: a great driver whose
  // man is walling him off still needs the pick, so we don't gate it out by his high
  // driveU. He WAVES IT OFF (screenWaveOff) only once a clear attack actually opens (open
  // shot or open lane) — hysteresis, so a called pick persists to set instead of churning
  // call→reject as the read flickers. Selective: an open handler just takes what's there.
  const best = Math.max(shootU, driveU, passU, postU);
  const laneOpen = isLaneClear(bh, def, h);
  const openShot = shootU >= SCREEN_WAIT_GREAT;
  const noGoodPass = bestPU < HOLD_PASS_QUALITY;
  const wantsScreen = tac.action === "pnr" && best !== postU && !openShot && !laneOpen && noGoodPass;
  // He waves off a called pick ONLY for a genuinely great standstill shot — not for a
  // transient open lane. (laneOpen flickers tick-to-tick; waving off on it dispersed the
  // screener constantly so the handler "rejected every screen" instead of using it. Once
  // he's called for the pick he commits to using it unless a clear shot opens up.)
  const screenWaveOff = openShot;

  return {
    who: bh,
    shootU,
    driveU,
    passU,
    postU,
    type,
    contest,
    mp,
    pts,
    open,
    dh,
    bestPass,
    bestPU,
    postDef,
    postEdge,
    toward: { x: lerp(bh.x, h.x, 0.72), y: lerp(bh.y, h.y, 0.6) },
    wantsScreen,
    screenWaveOff,
  };
}

/* Local frozen ball-holder lookup (mirrors snapshot.ballHolderView without
   importing it; kept local so this file owns its decide dependencies). */
function ballHolderViewLocal(s: Snapshot): PlayerView | null {
  if (s.ball.holderNum == null) return null;
  return s.off.find((v) => v.num === s.ball.holderNum) ?? null;
}
