import { DT, ARC_R, COURT_L } from "../core/constants.js";
import { dist, clamp, lerp, chance, randn, shotTypeFor, distToSeg } from "../core/math.js";
import { G, offTeam, defTeam, hoop, logEv } from "../core/state.js";
import { tacFor } from "../tactics/tactics.js";
import { threat } from "./defense.js";
import { attemptShot } from "./resolution.js";
import { beginLiveTransition } from "./transition.js";
import { spotsFor } from "./possession.js";
import { nearestDef, makeProb, contestOf } from "./shot.js";
import { effectiveTendencies, tendencyFactor } from "./tendency.js";
import { beginFouled } from "./resolution.js";
import { simTunables } from "./tunables.js";
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
const DRIVE_SCREEN_BONUS = 0.45; // extra drive utility off a PnR screen (coming off the pick)
const DRIVE_BASE_DIST_MIN = 6; // handler must be outside this range from the hoop to drive
const DRIVE_CONTINUATION_BONUS = 0.22; // extra drive utility when already mid-drive (keep attacking)

// Open-lane check: no defender in the corridor between handler and rim
const OPEN_LANE_CORRIDOR_WIDTH = 4.5; // ft half-width of the lane corridor
const OPEN_LANE_BONUS = 2.0; // drive-utility bonus when the lane is clear
const OPEN_LANE_MIN_DIST = 8; // only meaningful when handler is this far from the hoop

// Drive-and-kick: when help defense commits to a drive, pass to the open man
const DRIVE_KICK_HELP_DIST = 12; // a help defender must be within this of the driver
const DRIVE_KICK_OPEN_BONUS = 2.4; // pass-utility bonus for the kick-out target
const DRIVE_KICK_MIN_HANDLER_DIST = 14; // handler must be this far in to trigger kick consideration
const DRIVE_KICK_PASS_SLOPE = 1 / 30; // per point of passer pass attribute (above 50) boosts kick

// Post-feed: when a teammate is posting with a position edge, the handler feeds him
const POST_FEED_RANGE = 14; // ft to the hoop: a big this close can be fed
const POST_FEED_EDGE_MIN = 4; // minimum physical edge for a feed to be attractive
const POST_FEED_PASS_BONUS = 1.6; // pass-utility bonus when feeding a posting big
const POST_FEED_TEND_PIVOT = 70; // postUp tendency threshold to be feed-eligible (matches POST_OFFBALL_PIVOT)

// Three-point shot volume (moves 3PA without flattening per-player divergence).
const THREE_UTILITY_MULT = 0.78; // scales three-shoot utility; high-shootThree still out-shoots low
// Controls how strongly the shootThree tendency swings three volume: 1 = full
// (0.5..1.5) swing. Slightly above full keeps explicit three-point coaching
// visible after route-risk tuning removes some easy pass-first outcomes.
const THREE_TEND_COMPRESS = 1.1;
// Flat additive bump to open three-point utility. Lifts low-three teams toward
// the 3PA floor WITHOUT scaling up high-volume teams (they are already shooting),
// so it tightens the floor without pushing the pace-and-space ceiling over.
const THREE_UTILITY_FLOOR = 1.65;

// Post-up mechanic (adds close buckets + free throws for bigs). A post threat
// near the basket with a physical edge over his on-ball defender backs him down.
const POST_RANGE = 12; // ft to the hoop within which a post-up is available
const POST_EDGE_UTIL_MULT = 0.07; // converts physical edge -> base post-up utility
const POST_TEND_MULT = 1.7; // scales post-up utility by the postUp tendency factor
const POST_EDGE_MULT = 0.012; // make-prob bump per point of physical edge
const POST_EDGE_MAKE_CAP = 0.16; // ceiling on the make-prob bump from the edge
const POST_FOUL_BASE = 0.24; // baseline foul-draw chance on a backdown
const POST_FOUL_EDGE_SLOPE = 0.010; // extra foul-draw chance per point of edge
const POST_FOUL_CAP = 0.52; // ceiling on post-up foul-draw chance
const POST_OFFBALL_PIVOT = 70; // postUp tendency at/above which a big posts on the block off-ball

/* ---------- OFF-BALL ROLE + MOTION TUNING ----------
   Role classification and ball-reactive cutting knobs. Bigs operate INSIDE
   (dunker spot / short corner / block); shooters space to the perimeter. */
const BIG_SHOOT_THREE_MAX = 45; // shootThree below this -> treat as an inside (big) role
const BIG_POST_PIVOT = POST_OFFBALL_PIVOT; // high postUp also marks an inside role
const SCREENER_POP_THREE = 70; // a screening big only pops beyond the arc if shootThree above this

// Inside home spots (relative to the attacking hoop), assigned to bigs so they
// stop drifting to the arc. Homes are lane-adjacent; block touches are temporary.
const INSIDE_X = 5; // ft from the hoop along the baseline axis for block spots
const INSIDE_SHORT_X = 8.5; // short-corner depth
const DUNKER_X = 4; // dunker-spot depth (rolled-screener reset / lone big)

// Ball-reactive cutting. Frequencies are per decision tick (offenseDecide cadence)
// and stay small so motion reads as activity, not chaos.
const CUT_BASE_CHANCE = 0.006; // baseline basket-cut chance, scaled by driveRim factor
const CUT_PASS_BONUS = 0.006; // extra basket-cut chance the tick a pass is caught
const CUT_EARLY_CLOCK_BONUS = 0.003; // extra cut chance early in the shot clock (fades by mid-clock)
const CUT_EARLY_CLOCK_T = 12; // shot-clock seconds above which the early-clock bonus applies fully
const GIVE_AND_GO_CHANCE = 0.04; // chance the passer cuts to the rim right after passing (give-and-go)
const POST_REACT_CHANCE = 0.03; // chance a weak-side player lifts/fills to an open spot on a pass
const BACKDOOR_CHANCE = 0.035; // backdoor-cut chance vs tight ball-side denial, scaled by driveRim
const CUT_CHANCE_CAP = 0.022; // ceiling on the combined per-tick basket-cut chance
const TARGET_MIN_PERIMETER_DIST = 12; // classic motion spacing: keep perimeter slots a full gap apart
const TARGET_MIN_INTERIOR_DIST = 7.5; // interior players can be closer, but not stacked
const TARGET_MIN_MIXED_DIST = 9.5; // one inside / one perimeter needs a passing lane gap
const HIGH_POST_MIN_DEPTH = 9; // relative to hoop: FT-line/high-post band starts here
const HIGH_POST_MAX_DEPTH = 17;
const HIGH_POST_MIN_Y = 17;
const HIGH_POST_MAX_Y = 33;
const LANE_CLEAR_WARN_T = 1.7;
const LANE_CLEAR_LOW_IQ_EXTRA_T = 0.9;

type ReservedTarget = { p: Player; point: Point; inside: boolean };

/* ---------- 4) OFFENSE AI ---------- */
export function offenseDecide(): void {
  const off = offTeam(),
    def = defTeam(),
    h = hoop(),
    tac = tacFor(G.offense);
  const tuning = simTunables();
  // ----- run primary action so possessions have shape -----
  runAction(off, def, h, tac);

  // ----- ball-handler decision (every decideCD ticks) -----
  if (G.decideCD > 0) {
    G.decideCD--;
  } else {
    G.decideCD = 4; // decide ~ every 0.4s
    const bh = G.ball.holder;
    if (!bh) return;

    // ----- on-ball turnover / strip check (before any shoot/drive/pass) -----
    // The on-ball defender can force a live-ball turnover this window. Scales with
    // defensive pressure, the defender's steal+gambleSteal vs the handler's
    // handle+iq, and whether the handler is driving into the defense.
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
          if (chance(STRIP_CLEAN_SHARE)) {
            // clean steal: the on-ball defender takes it and pushes the other way
            onBallDef.stats.stl++;
            logEv(`${onBallDef.name} strips ${bh.name} — steal!`, "to");
            G.driving = false;
            beginLiveTransition(onBallDef, true);
          } else {
            // lost ball / bad handle: nearest defender recovers (no STL credited)
            const recover = nearestDef(bh, def).d || onBallDef;
            logEv(`${bh.name} loses the handle — turnover`, "to");
            G.driving = false;
            beginLiveTransition(recover);
          }
          return;
        }
      }
    }

    const dh = dist(bh, h),
      type = shotTypeFor(dh);
    const contest = contestOf(bh, def);
    const open = clamp(1 - contest, 0, 1);
    const pts = type === "three" ? 3 : 2;
    const mp = makeProb(bh, type, contest);
    const ev = mp * pts;

    // shot-selection multiplier from your tactics
    const selM = (() => {
      const s = tac.shotSel;
      if (type === "three") return s === "three" ? 1.4 : s === "rim" ? 0.55 : 1;
      if (type === "rim" || type === "close") return s === "rim" ? 1.4 : s === "three" ? 0.7 : 1;
      return s === "three" ? 0.7 : 1;
    })();
    // urgency as shot clock winds down
    const urg = G.shotClock < 10 ? (10 - G.shotClock) / 10 : 0;

    // zone-specific shooting tendency (driveRim doubles as rim-shooting propensity).
    // postUp drives the post-up branch below: a post threat near the basket with a
    // physical edge over his on-ball defender backs him down for a close look or foul.
    const tendencies = effectiveTendencies(bh);
    const shootTend =
      type === "three" ? tendencies.shootThree : type === "mid" ? tendencies.shootMid : tendencies.driveRim;
    let shootU = ev * selM * (0.35 + 0.65 * open) + urg * 2.4;
    if (type === "three") {
      // compressed tendency swing keeps the high/low ordering but narrows the
      // absolute spread, then THREE_UTILITY_MULT sets the overall volume.
      const tf = 1 + (tendencyFactor(shootTend) - 1) * THREE_TEND_COMPRESS;
      shootU *= tf * THREE_UTILITY_MULT * tuning.decisions.threeUtilityScale;
      // open-look floor: nudges MILDLY-reluctant but capable shooters to take the
      // open three. The reluctance weight is a band peaking around shootThree ~50
      // and fading to zero both at neutral-plus (high-volume teams already shoot
      // plenty) AND at the very-low extreme (a team that truly never shoots threes
      // must stay low, so per-player divergence is preserved at the extremes).
      const reluctance = clamp((shootTend - 26) / 18, 0, 1) * clamp((64 - shootTend) / 13, 0, 1);
      // capability band peaks for solid-but-not-elite shooters (three ~55-68) and
      // fades for both non-shooters (would tank 3P%) and elite high-volume shooters
      // (already shooting plenty — keeps pace-and-space teams under the ceiling).
      const t3 = bh.attr.three;
      const capable = clamp((t3 - 42) / 16, 0, 1) * clamp((78 - t3) / 16, 0, 1);
      shootU += THREE_UTILITY_FLOOR * tuning.decisions.threeUtilityScale * open * reluctance * capable;
    } else {
      shootU *= tendencyFactor(shootTend);
    }

    // drive utility: open lane + handle/speed edge vs man, defender lag, low-iq defender
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

      // defender lag: if the on-ball defender's target is far from the handler,
      // he is closing out or caught off-guard — advantageous for the driver
      let lagBonus = 0;
      if (onBall && onBall.target) {
        const defLag = dist(onBall.target, bh);
        if (defLag > DRIVE_LAG_DIST_THRESHOLD) lagBonus = DRIVE_LAG_BONUS;
      }

      // tight defender with a handle advantage: the defender presses up but the
      // handler has enough skill to blow by him
      let tightBonus = 0;
      if (tac.pressure === "tight" && handleOf(bh) >= DRIVE_TIGHT_HANDLE_FLOOR) {
        tightBonus = DRIVE_TIGHT_BONUS;
      }

      // off-screen bonus: coming off the PnR pick the handler gets a step on his man
      const offScreenBonus = G.screen && G.screen.ball === bh && dist(bh, G.screen.screener) < 6
        ? DRIVE_SCREEN_BONUS
        : 0;

      const continuationBonus = G.driving ? DRIVE_CONTINUATION_BONUS : 0;
      driveU = (clamp(handleEdge + speedEdge, -0.3, 0.65) + 0.68 + iqBonus + lagBonus + tightBonus + offScreenBonus + continuationBonus)
        * (1 - laneBlock * 0.7);
    }

    // open-lane bonus: no defender in the corridor between the handler and the hoop
    if (dh > OPEN_LANE_MIN_DIST) {
      const laneOpen = isLaneClear(bh, def, h);
      if (laneOpen) driveU += OPEN_LANE_BONUS;
    }

    if (tac.shotSel === "rim") driveU += 0.25;
    if (tac.shotSel === "three") driveU -= 0.2;
    driveU *= tendencyFactor(tendencies.driveRim) * tuning.decisions.driveUtilityScale;

    // pass utility: find best teammate (more open / better look)
    // Also checks for drive-and-kick targets (open man after help commits)
    // and post-feed targets (posting big with a position edge).
    const driveKickActive = G.driving && dh < DRIVE_KICK_MIN_HANDLER_DIST
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
      const advance = td < dh - 2 ? 0.3 : 0; // reward feeding closer looks

      // drive-and-kick: if help has committed, the player whose defender helped is open
      let kickBonus = 0;
      if (driveKickActive) {
        const tDef = def.find((d) => d.assign === t);
        if (tDef && isHelping(tDef, bh, h)) kickBonus = kickPassBonus;
      }

      // post-feed: a teammate posting near the basket with a physical edge earns a bonus
      const postFeedBonus = postFeedValue(t, def, h);

      const pu = to * 0.9 + tev * 0.5 + advance + kickBonus + postFeedBonus
        - passSelectionPenalty(bh, t, h);
      if (pu > bestPU) {
        bestPU = pu;
        bestPass = t;
      }
    }
    // ball-movement bias early in clock so it isn't iso every time
    const passBias = G.possClock < 6 ? 0.5 : 0.1;
    let passU = (bestPU + passBias) * tendencyFactor(tendencies.pass) * tuning.decisions.passUtilityScale;

    // post-up utility: a post threat near the basket can back down a weaker
    // on-ball defender. The physical EDGE pits the handler's strength/mass/length
    // against the defender's strength/mass and interior defense; utility scales
    // with that edge AND the postUp tendency (coaching/PR3 already folded in).
    const postDef = onBall;
    let postEdge = 0;
    let postU = -1;
    if (postDef && dh <= POST_RANGE) {
      postEdge =
        bh.attr.strength + weightTerm(bh) + heightTerm(bh) -
        (postDef.attr.strength + weightTerm(postDef) + postDef.attr.interiorD * 0.4);
      postU =
        Math.max(0, postEdge) * POST_EDGE_UTIL_MULT * tendencyFactor(tendencies.postUp) * POST_TEND_MULT;
    }

    // low IQ adds noise to the choice
    const noise = ((99 - bh.attr.iq) / 99) * 0.6;
    shootU += randn() * noise;
    driveU += randn() * noise;
    passU += randn() * noise;
    if (postU > 0) postU += randn() * noise;

    const best = Math.max(shootU, driveU, passU, postU);
    if (best === postU && postU > 0) {
      G.driving = false;
      postUp(bh, postDef!, contest, postEdge);
    } else if (best === shootU && (open > 0.2 || G.shotClock < 8 || dh < 6)) {
      G.driving = false;
      attemptShot(bh, type, contest, pts, mp);
    } else if (best === driveU) {
      G.driving = true;
      bh.target = { x: lerp(bh.x, h.x, 0.72), y: lerp(bh.y, h.y, 0.60) };
    } else if (bestPass) {
      G.driving = false;
      startPass(bh, bestPass);
    } else {
      G.driving = false;
      attemptShot(bh, type, contest, pts, mp);
    } // nothing better, just shoot
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
  const edge =
    t.attr.strength + weightTerm(t) + heightTerm(t) -
    (tDef.attr.strength + weightTerm(tDef) + tDef.attr.interiorD * 0.4);
  if (edge < POST_FEED_EDGE_MIN) return 0;
  return POST_FEED_PASS_BONUS * tendencyFactor(tend.postUp);
}

function rimHelp(bh: Player, def: Player[], h: Point): number {
  // how protected is the rim right now (0..1)
  let v = 0;
  for (const d of def) {
    if (dist(d, h) < 7) v += clamp((d.attr.interiorD + d.attr.block) / 200, 0, 0.6);
  }
  return clamp(v, 0, 1);
}

/* primary action: pick & roll or motion, plus off-ball movement for everyone. */
function runAction(off: Player[], def: Player[], h: Point, tac: Tactics): void {
  const dir = G.attackHoop === "R" ? -1 : 1;
  G.actionT += DT;
  const sp0 = spotsFor(G.attackHoop);
  const bh = G.ball.holder;
  // while the ball is in flight (pass or shot) nobody has it: just hold spacing
  if (!bh) {
    off.forEach((p, i) => (p.target = sp0[i]));
    return;
  }

  if (tac.action === "pnr") {
    // pick the eligible big with the highest screen tendency; fall back to role/off[4]
    let screener = off.find((p) => p.role === "screener") || off[4];
    let bestScreen = screener === bh ? -1 : effectiveTendencies(screener).screen;
    for (const p of off) {
      if (p === bh) continue;
      const sc = effectiveTendencies(p).screen;
      if (sc > bestScreen) {
        bestScreen = sc;
        screener = p;
      }
    }
    if (G.actionPhase === "bringup") {
      bh.target = { x: h.x + dir * 21, y: 25 };
      // come UP to the level of the screen from the interior, not from the arc
      screener.target = { x: h.x + dir * 13, y: 30 };
      G.screen = { ball: bh, screener };
      if (G.possClock > 1.6) {
        G.actionPhase = "screen";
      }
    } else if (G.actionPhase === "screen") {
      screener.target = { x: bh.x + dir * 1.5, y: bh.y - 5 };
      G.screen = { ball: bh, screener };
      if (dist(screener, bh) < 5 && G.possClock > 2.6) {
        G.actionPhase = "roll";
      }
    } else if (G.actionPhase === "roll") {
      // a genuine shooting big pops to the arc; everyone else rolls hard to the rim
      const pops = screener.attr.three > SCREENER_POP_THREE && effectiveTendencies(screener).shootThree > SCREENER_POP_THREE;
      const rolled = dist(screener, h) < 8;
      if (pops) {
        screener.target = { x: h.x + dir * 22, y: 30 };
      } else if (rolled) {
        // reset to an inside spot once the roll arrives — do NOT jog back out to the arc
        screener.target = legalInsideHome(screener, h, dir);
      } else {
        screener.target = legalInsideHome(screener, h, dir);
      }
      G.screen = { ball: bh, screener };
    }
    if (shouldClearLane(screener, h)) screener.target = laneClearSpot(screener, screener.target || screener, h, dir);
    if (screener.target) screener.target = clampInteriorTarget(screener.target);
  } else {
    G.screen = null;
  }

  // off-ball movement for all non-handler players (the pnr screener is handled above)
  offBallMove(off, def, h, dir, tac);
}

/* Classifies an off-ball player as an INSIDE (big) role vs a perimeter shooter.
   A low-three OR high-postUp player operates near the rim; everyone else spaces
   the floor. Drives inside-vs-perimeter spot assignment in offBallMove. */
export function isInsidePlayer(p: Player): boolean {
  const t = effectiveTendencies(p);
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
): number {
  const awareness = spacingAwareness(p);
  let nearestDef = 16;
  for (const d of def) nearestDef = Math.min(nearestDef, dist(d, candidate));

  let score = nearestDef * 0.35 - dist(candidate, preferred) * 0.75;
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
): Point {
  const candidates = dedupeSpots([preferred, ...options]);
  let best = candidates[0],
    bestScore = -1e9;
  for (const c of candidates) {
    const score = targetScore(p, c, preferred, reserved, def, h, inside);
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

/* Off-ball movement: role-true spacing (bigs inside, shooters on the perimeter),
   relocation to open space, lane-clearing on drives, ball-reactive basket cuts
   with refill, give-and-go by the passer, weak-side lift, and backdoor cuts
   against tight ball-side denial. Generates open looks against help defense. */
function offBallMove(off: Player[], def: Player[], h: Point, dir: number, tac: Tactics): void {
  const bh = G.ball.holder;
  if (!bh) return;
  const spots = spotsFor(G.attackHoop);
  const driving = G.driving && dist(bh, h) < 20;
  const driveLow = bh.y < 25;
  // a pass was just caught this tick (set in possession.tick) -> trigger more motion
  const justPassed = G.decideCD === 3;
  const passer = G.pendingAssist || null;
  const earlyClock = clamp((G.shotClock - (24 - CUT_EARLY_CLOCK_T)) / CUT_EARLY_CLOCK_T, 0, 1);

  // role-true spot assignment: collect the off-ball movers, hand the perimeter
  // spotsFor() slots to the shooters and the inside slots to the bigs.
  const movers: Player[] = [];
  for (const p of off) {
    if (p === bh) continue;
    if (tac.action === "pnr" && (p.role === "screener" || G.screen?.screener === p)) continue; // screener owned by pnr logic
    movers.push(p);
  }
  const bigs = movers.filter(isInsidePlayer);
  // perimeter spots are all spotsFor slots except the handler slot (index 0)
  const perimeterSpots = [spots[1], spots[2], spots[3], spots[4]];
  // inside homes stay adjacent to the lane; post threats flash to the block
  // only while their lane timer is low.
  const insideSpots: Point[] = [
    { x: h.x + dir * INSIDE_SHORT_X, y: 13 }, // left short corner
    { x: h.x + dir * INSIDE_SHORT_X, y: 37 }, // right short corner
    { x: h.x + dir * DUNKER_X, y: 13 }, // left dunker-adjacent
    { x: h.x + dir * DUNKER_X, y: 37 }, // right dunker-adjacent
  ];
  // stable assignment by the player's seeded spot index so it does not flip-flop
  const sortByObSpot = (a: Player, b: Player) => (a.ob?.spot ?? 0) - (b.ob?.spot ?? 0);
  const shooters = movers.filter((p) => !isInsidePlayer(p)).sort(sortByObSpot);
  bigs.sort(sortByObSpot);
  const homeOf = new Map<Player, Point>();
  shooters.forEach((p, i) => homeOf.set(p, perimeterSpots[i % perimeterSpots.length]));
  bigs.forEach((p, i) => homeOf.set(p, insideSpots[i % insideSpots.length]));

  // index defenders by their assignment once (first match wins, matching find())
  const defByAssign = new Map<Player, Player>();
  for (const x of def) if (x.assign && !defByAssign.has(x.assign)) defByAssign.set(x.assign, x);
  const reserved: ReservedTarget[] = [];
  if (bh.target) reserved.push({ p: bh, point: bh.target, inside: false });
  for (const p of off) {
    if (p === bh || movers.includes(p) || !p.target) continue;
    reserved.push({ p, point: p.target, inside: p.role === "screener" || isInsidePlayer(p) });
  }
  let laneCutReserved = movers.some((p) => p.ob?.state === "cut");
  for (const p of movers) {
    const ob = p.ob;
    if (!ob) continue;
    ob.t += DT;
    const d = defByAssign.get(p);
    const tend = effectiveTendencies(p);
    const cutFactor = tendencyFactor(tend.driveRim);
    const inside = isInsidePlayer(p);
    const postThreat = tend.postUp >= POST_OFFBALL_PIVOT;
    let home = homeOf.get(p) || spots[ob.spot] || spots[1];
    // a high-postUp big posts up on the block so the pass logic can feed him
    if (postThreat && (p.offLaneT ?? 0) < 1.2) home = { x: h.x + dir * INSIDE_X, y: ob.spot % 2 ? 18 : 32 };
    const spacingOptions = inside ? insideSpots : perimeterSpots;

    // --- cut in progress ---
    if (ob.state === "cut") {
      p.target = { x: h.x + dir * 2.5, y: ob.cutY as number };
      reserved.push({ p, point: p.target, inside: true });
      if (dist(p, { x: h.x, y: 25 }) < 5.5 || ob.t > 2.0) {
        ob.state = "fill";
        ob.t = 0;
        // bigs refill inside; shooters fill the most open perimeter spot
        ob.fill = inside ? home : mostOpenSpot(p, perimeterSpots, off, def);
      }
      continue;
    }
    if (ob.state === "fill") {
      // refill the chosen open spot (an inside spot for bigs, a perimeter spot
      // for shooters); fall back to home if none was recorded
      const fillTo = ob.fill || home;
      p.target = reserveAwareTarget(p, fillTo, spacingOptions, reserved, def, h, inside);
      ob.fill = p.target;
      reserved.push({ p, point: p.target, inside });
      if (dist(p, p.target) < 3 || ob.t > 2.6) {
        ob.state = "space";
        ob.t = 0;
      }
      continue;
    }

    // --- spacing read ---
    let tgt: Point = { x: home.x, y: home.y };
    if (shouldClearLane(p, h)) {
      tgt = laneClearSpot(p, home, h, dir);
    } else if (driving) {
      // clear the strong side: if I'm on the drive side, relocate to the weak side
      // (this both opens the lane and sets up the kick-out)
      const onDriveSide = p.y < 25 === driveLow;
      if (onDriveSide && dist(p, h) < 19) tgt = { x: home.x, y: 50 - home.y };
    } else {
      // give-and-go: the player who just passed cuts hard to the rim
      if (!laneCutReserved && justPassed && p === passer && chance(GIVE_AND_GO_CHANCE * cutFactor)) {
        ob.state = "cut";
        ob.t = 0;
        ob.cutY = p.y < 25 ? 19 : 31;
        p.target = { x: h.x + dir * 2.5, y: ob.cutY };
        reserved.push({ p, point: p.target, inside: true });
        laneCutReserved = true;
        continue;
      }
      // backdoor vs tight ball-side denial (scaled by driveRim)
      if (
        !laneCutReserved &&
        d &&
        dist(d, p) < 3.0 &&
        dist(d, h) > dist(p, h) - 1 &&
        threat(p) > 0.45 &&
        chance(BACKDOOR_CHANCE * cutFactor)
      ) {
        ob.state = "cut";
        ob.t = 0;
        ob.cutY = p.y < 25 ? 20 : 30;
        p.target = { x: h.x + dir * 2.5, y: ob.cutY };
        reserved.push({ p, point: p.target, inside: true });
        laneCutReserved = true;
        continue;
      }
      // weak-side lift/fill into open space the moment the ball moves
      if (justPassed && p !== passer && chance(POST_REACT_CHANCE)) {
        ob.state = "fill";
        ob.t = 0;
        ob.fill = reserveAwareTarget(
          p,
          mostOpenSpot(p, spacingOptions, off, def),
          spacingOptions,
          reserved,
          def,
          h,
          inside,
        );
        p.target = ob.fill;
        reserved.push({ p, point: p.target, inside });
        continue;
      }
      // relocate into open space: slide a few feet away from my own defender
      if (d && dist(d, p) < 7) {
        const away = Math.sign(p.y - d.y) || 1;
        tgt = { x: home.x, y: clamp(home.y + away * 3.5, 3, 47) };
      }
      // ball-reactive basket cut: base rate scaled by driveRim, with bonuses
      // the tick a pass is caught and early in the shot clock.
      const cutChance = clamp(
        (CUT_BASE_CHANCE + (justPassed ? CUT_PASS_BONUS : 0) + earlyClock * CUT_EARLY_CLOCK_BONUS) * cutFactor,
        0,
        CUT_CHANCE_CAP,
      );
      if (!laneCutReserved && chance(cutChance)) {
        ob.state = "cut";
        ob.t = 0;
        ob.cutY = p.y < 25 ? 19 : 31;
        p.target = { x: h.x + dir * 2.5, y: ob.cutY };
        reserved.push({ p, point: p.target, inside: true });
        laneCutReserved = true;
        continue;
      }
    }
    p.target = reserveAwareTarget(p, tgt, spacingOptions, reserved, def, h, inside);
    reserved.push({ p, point: p.target, inside });
  }
}

function mostOpenSpot(p: Player, spots: Point[], off: Player[], def: Player[]): Point {
  let best = spots[3],
    bs = -1e9;
  for (const s of spots) {
    let nd = 1e9;
    for (const d of def) nd = Math.min(nd, dist(d, s));
    let occ = false;
    for (const o of off) {
      if (o !== p && dist(o, s) < 4) occ = true;
    }
    const score = nd - (occ ? 20 : 0);
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
  G.ball.passDur = Math.max(2, (dist(from, to) * 0.6) | 0);
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
        logEv(`${d.name} jumps the passing lane — steal!`, "to");
        beginLiveTransition(d, true);
        return;
      }
    }
  }
}
