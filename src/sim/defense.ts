import { G, offTeam, defTeam, hoop } from "../core/state.js";
import { maxSpeed } from "./movement.js";
import { dist, clamp, lerp } from "../core/math.js";
import { rules } from "../core/rules.js";
import { effectiveTendencies, tendencyFactor } from "./tendency.js";
import type { Player, Point, Tactics, Tendencies } from "../types.js";
import type { Snapshot } from "./snapshot.js";
import type { DecidedIntent, Intent } from "./intent.js";

const LANE_MIN_Y = 17;
const LANE_MAX_Y = 33;
const LANE_DEPTH_FROM_HOOP = 13.75;
const DEF_LANE_CLEAR_WARN_T = 1.5;
const DEF_LANE_LOW_IQ_EXTRA_T = 1.0;
const OFFBALL_TRACK_LAG_MAX = 4.8;
const OFFBALL_TRACK_SPEED_START = 2.5;
const OFFBALL_TRACK_SPEED_RANGE = 11;
// Closeout rotation: when the ball-handler has no defender within this distance,
// the nearest defender sprints to close out, stopping CLOSEOUT_GAP ft ball-side.
const CLOSEOUT_OPEN_DIST = 7;
const CLOSEOUT_GAP = 3;

function paintBand(pt: Point, h: Point): boolean {
  return Math.abs(pt.x - h.x) <= LANE_DEPTH_FROM_HOOP && pt.y >= LANE_MIN_Y && pt.y <= LANE_MAX_Y;
}

function spacingAwareness(p: Player): number {
  return clamp((p.attr.iq - 35) / 55, 0.35, 1.15);
}

function shouldClearDefensiveLane(d: Player, off: Player[], h: Point): boolean {
  if (!rules.defensiveThreeSeconds || !paintBand(d, h)) return false;
  if (off.some((p) => dist(d, p) <= rules.defensiveThreeSecondsGuardingDistance)) return false;
  const awareness = spacingAwareness(d);
  const warnAt = DEF_LANE_CLEAR_WARN_T + (1.15 - awareness) * DEF_LANE_LOW_IQ_EXTRA_T;
  return (d.defLaneT ?? 0) >= warnAt;
}

function matchupDefenseRating(d: Player, m: Player, h: Point): number {
  const depth = dist(m, h);
  const perimeterWeight = clamp((depth - 8) / 16, 0, 1);
  return d.attr.interiorD * (1 - perimeterWeight) + d.attr.perimD * perimeterWeight;
}

function trackingQuality(d: Player, m: Player, h: Point): number {
  const rating = matchupDefenseRating(d, m, h);
  return clamp((d.attr.iq * 0.55 + rating * 0.45 - 42) / 48, 0, 1);
}

export function offBallDefensiveTarget(d: Player, m: Player, h: Point): Point {
  const gap = 3 + (1 - threat(m)) * 3;
  // Sit on the line between man and ball ("on the line, up the line") so the
  // defender can see both. Blend 15% toward ball / 85% toward basket to shift
  // positioning ball-side without sitting fully in passing lanes.
  const bx = G.ball.x,
    by = G.ball.y;
  const manToBall = Math.hypot(bx - m.x, by - m.y) || 1;
  const manToHoop = Math.max(dist(m, h), 1);
  const ballBase = {
    x: lerp(m.x, bx, gap / manToBall),
    y: lerp(m.y, by, gap / manToBall),
  };
  const hoopBase = {
    x: lerp(m.x, h.x, gap / manToHoop),
    y: lerp(m.y, h.y, gap / manToHoop),
  };
  const base = {
    x: lerp(hoopBase.x, ballBase.x, 0.15),
    y: lerp(hoopBase.y, ballBase.y, 0.15),
  };
  const moverSpeed = Math.hypot(m.vx, m.vy);
  const moving = clamp((moverSpeed - OFFBALL_TRACK_SPEED_START) / OFFBALL_TRACK_SPEED_RANGE, 0, 1);
  if (moving <= 0) return base;

  const quality = trackingQuality(d, m, h);
  const lag = OFFBALL_TRACK_LAG_MAX * moving * (1 - quality);
  if (lag <= 0.05) return base;
  return { x: base.x - (m.vx / moverSpeed) * lag, y: base.y - (m.vy / moverSpeed) * lag };
}


export function threat(p: Player): number {
  // 0..1 how much you must respect this man
  return clamp((p.attr.three * 0.6 + p.attr.mid * 0.2 + p.attr.finishing * 0.2 - 40) / 55, 0, 1);
}

// On-ball SAG: how much the on-ball defender must respect a man WITH THE BALL out
// on the perimeter — his shooting (will he take the open jumper) plus his ability
// to blow by (handle/speed). Note this excludes finishing: a back-to-the-basket
// big who dunks but won't shoot or drive from 20 ft gets sagged off out there.
export function perimeterThreat(p: Player): number {
  const handle = Math.max(p.attr.handleLeft, p.attr.handleRight);
  return clamp(
    (p.attr.three * 0.5 + p.attr.mid * 0.2 + handle * 0.2 + p.attr.speed * 0.1 - 40) / 55,
    0,
    1,
  );
}

/* How squarely `navDef` is screened trying to reach `handler`: 1 when the screener
   sits right on his path between him and the ball, 0 when it's nowhere near. Feeds
   the switch decision — a defender who's stuck on the pick is more willing to switch
   than fight over it. */
function screenContact(navDef: Player, handler: Player, screener: Player): number {
  const abx = handler.x - navDef.x,
    aby = handler.y - navDef.y;
  const abLen2 = abx * abx + aby * aby || 1;
  let t = ((screener.x - navDef.x) * abx + (screener.y - navDef.y) * aby) / abLen2;
  if (t <= 0.1 || t >= 0.95) return 0; // screener not between defender and ball
  t = clamp(t, 0, 1);
  const perp = Math.hypot(screener.x - (navDef.x + t * abx), screener.y - (navDef.y + t * aby));
  return clamp(1 - perp / SCREEN_CONTACT_PERP, 0, 1);
}

/* One defender's willingness to TAKE a switch — i.e. to pick up `newMan`. Positive
   = willing. Falls with the size/speed the new man has on him (the mismatch he'd
   inherit), rises when he's squarely screened and with his IQ. A coach switch lever
   will add a term here later. */
function switchWill(d: Player, newMan: Player, contact: number): number {
  const sizeGap = Math.max(0, newMan.attr.height - d.attr.height);
  const speedGap = Math.max(0, newMan.attr.speed - d.attr.speed);
  return (
    SWITCH_BASE +
    contact * SWITCH_CONTACT_W +
    (d.attr.iq - 60) * SWITCH_IQ_W -
    sizeGap * SWITCH_SIZE_W -
    speedGap * SWITCH_SPEED_W
  );
}

/* Per-screen coverage decision, shared by DECIDE (for targets) and RESOLVE (for the
   assign swap) so they never diverge. Under a switch scheme the two defenders each
   decide whether to take the switch (switchWill); it happens only on mutual
   agreement, else they drop. drop/hedge schemes are unchanged. */
export type ScreenCoverage = "switch" | "drop" | "hedge";
export function decideScreenCoverage(
  ballD: Player,
  scrD: Player,
  ball: Player,
  scr: Player,
  tac: Tactics,
): ScreenCoverage {
  if (tac.pnr === "hedge") return "hedge";
  if (tac.pnr === "drop") return "drop";
  // switch scheme: each defender weighs the matchup he'd inherit + how he was screened
  const contact = screenContact(ballD, ball, scr);
  const ballDWill = switchWill(ballD, scr, contact); // ballD would pick up the screener
  const scrDWill = switchWill(scrD, ball, contact); // scrD would pick up the handler
  return ballDWill > 0 && scrDWill > 0 ? "switch" : "drop";
}
const SAG_MAX = 4.0; // ft of extra cushion the on-ball defender gives a zero-perimeter-threat handler
const SAG_MIN_DEPTH = 10; // ft from rim: no sag at the rim, full sag fades in beyond this
const SAG_DEPTH_RANGE = 12; // ft over which the outside-the-rim sag fades to full
const SAG_SPEED_PIVOT = 70; // defender speed below which he sags a bit more (can't pressure safely)
const SAG_SLOW_MAX = 1.5; // ft of extra cushion for a very slow on-ball defender
const BEAT_EDGE_W = 1 / 25; // per point of the handler's quickness/handle edge → share of a full beat (0..1)
const BEAT_TRAIL = 4; // ft a fully-beaten on-ball defender ends up trailing — a clear step behind, not goal-side

/* ---------- ON-BALL STANCE: pressure vs contain (per-defender utility) ----------
   The on-ball defender CHOOSES his stance instead of always running the fixed sag
   formula: pressure (crowd the handler, take away the shot/drive) vs contain (sag,
   wall the drive, concede the jumper). The chosen stance is a small multiplicative
   DEVIATION (onBallSagScale) on the EXISTING sag cushion — the geometry is unchanged,
   only HOW MUCH sag is applied is now a decision. The base formula already trades sag
   against the handler's perimeter threat, so the deviation is EXACTLY 1.0 at neutral
   coaching & matchup (the well-tuned cushion is preserved when no lever is set):
     pressure (scale < 1): aggressive (gambleSteal) coaching, a LATE shot clock (force
         a tough shot), or a handler I'm quicker than → crowd him.
     contain  (scale > 1): help-lean (helpDefense) coaching, or a quicker handler I
         can't safely crowd (speed/handle edge over me) → wall the drive.
   Pure & deterministic; reads only frozen state. */
const PRESS_GAMBLE_W = 0.12; // per (gambleSteal factor - 1): aggressive coaching presses
const CONTAIN_HELP_W = 0.12; // per (helpDefense factor - 1): help-lean coaching contains
const PRESS_LATECLOCK_W = 0.1; // pressure added as the shot clock winds down
const PRESS_LATECLOCK_T = 7; // shot clock at/under which the late-clock press is full
const CONTAIN_QUICK_W = 0.006; // per point the handler's (speed+handle) edge over the defender
const SAG_SCALE_MIN = 0.65; // tightest pressure cushion (× the formula sag)
const SAG_SCALE_MAX = 1.4; // deepest contain cushion
const SAG_SCALE_NEUTRAL = 1.0; // neutral center: the tuned formula cushion untouched

function quicknessEdge(handler: Player, d: Player): number {
  return handler.attr.speed - d.attr.speed + (handleOf(handler) - d.attr.perimD) * 0.6;
}

function handleOf(p: Player): number {
  return Math.max(p.attr.handleLeft, p.attr.handleRight);
}

/* Multiplier on the EXISTING sag cushion: 1.0 = the tuned formula untouched; <1 =
   pressure (crowd), >1 = contain (sag). Zero deviation at neutral coaching & matchup
   so the calibrated geometry is preserved; coaching and a clear quickness edge move
   it. Pure (no rng), snapshot-safe. */
function onBallSagScale(handler: Player, d: Player, shotClock: number, eff: Tendencies): number {
  const gambleDev = tendencyFactor(eff.gambleSteal) - 1; // >0 gamble, <0 safe
  const helpDev = tendencyFactor(eff.helpDefense) - 1; // >0 help-lean
  const lateClock = clamp((PRESS_LATECLOCK_T + 4 - shotClock) / (PRESS_LATECLOCK_T + 4), 0, 1);
  // quickness term is SYMMETRIC: a quicker handler → contain (looser), a slower one →
  // press (tighter). Symmetric so it does not bias the AVERAGE cushion looser (which
  // would soften neutral D); it only redistributes pressure by matchup.
  const press = PRESS_GAMBLE_W * gambleDev + PRESS_LATECLOCK_W * lateClock;
  const contain = CONTAIN_HELP_W * helpDev + CONTAIN_QUICK_W * quicknessEdge(handler, d);
  return clamp(SAG_SCALE_NEUTRAL - press + contain, SAG_SCALE_MIN, SAG_SCALE_MAX);
}

/* ---------- OFF-BALL STANCE: deny vs sag (per-defender utility) ----------
   Each off-ball defender CHOOSES how to play the passing lane to his man instead of
   always sitting "on the line, up the line". He scores `deny` (overplay the lane to
   a dangerous man, shade ball-side) vs `sag` (drop toward the lane/help, shade
   help-side). The chosen stance SHIFTS the existing offBallDefensiveTarget along the
   man→ball vs man→hoop axis via a -1..+1 `denyBias`: +1 = more ball-side/up-the-line
   (deny), -1 = more help-side/rim (sag). 0 reproduces the original target.

   Utility drivers:
   - threat(man) → deny a dangerous shooter's catch; sag off a non-threat
   - relevance to the ball (closer man / one pass away) → deny; far weak-side → sag
   - coaching: aggression (gambleSteal) → deny; help-lean (helpDefense) → sag. */
// The off-ball target ("on the line, up the line") is itself well-tuned (it already
// folds in man-threat via its `gap`), so the stance is expressed as a DEVIATION that
// is ZERO at neutral coaching — the base geometry is preserved exactly when no coach
// lever is set, which is what keeps neutral PPP on its calibrated mark. The lever:
//   deny (+): aggressive (gambleSteal) coaching overplays the lane to a man who is
//             ALSO a real threat near the ball (the extra-threat term only ADDS to an
//             already-aggressive read, so it can't perturb the neutral baseline).
//   sag  (-): help-lean (helpDefense) coaching drops toward the lane/help.
const DENY_GAMBLE_W = 1.0; // per (gambleSteal factor - 1): aggressive coaching denies
const SAG_HELP_W = 1.0; // per (helpDefense factor - 1): help-lean coaching sags
// A dangerous man near the ball amplifies an ALREADY-aggressive deny (gated on the
// coaching deviation so it is exactly 0 at neutral): you really jump the lane of a
// shooter one pass away when your coach has you gambling.
const DENY_THREAT_AMP = 1.0; // multiplier on the deny term per (threat near the ball)
const DENY_NEAR_DIST = 20; // ft man-to-ball over which "near the ball" fades to 0
// Feet of positional shift at full deny / full sag — modest nudges (a step into the
// lane, not a relocation). The sag step is small so weak-side men don't vacate the
// passing lanes (which would suppress lane steals and lift pace).
const DENY_SHIFT_FT = 2.2; // step toward the man→ball line (more ball-side)
const SAG_SHIFT_FT = 1.6; // step toward the man→hoop line (more help-side / rim)

function offBallDenyBias(d: Player, m: Player, ballPt: Point, eff: Tendencies): number {
  const gambleDev = tendencyFactor(eff.gambleSteal) - 1; // >0 gamble, <0 safe
  const helpDev = tendencyFactor(eff.helpDefense) - 1; // >0 help-lean, <0 stay-home
  const manToBall = Math.hypot(ballPt.x - m.x, ballPt.y - m.y);
  const nearBall = clamp(1 - manToBall / DENY_NEAR_DIST, 0, 1);
  // deny grows with gamble coaching, amplified by a dangerous man near the ball
  const denyU = Math.max(0, gambleDev) * DENY_GAMBLE_W * (1 + DENY_THREAT_AMP * threat(m) * nearBall);
  // sag grows with help-lean coaching; safe coaching (gambleDev<0) also drops a touch
  const sagU = Math.max(0, helpDev) * SAG_HELP_W + Math.max(0, -gambleDev) * DENY_GAMBLE_W;
  return Math.tanh((denyU - sagU) * 1.2);
}

/* Shift the neutral off-ball target toward the lane (deny) or toward help (sag).
   bias>0 → step toward man→ball; bias<0 → step toward man→hoop. */
function shiftOffBallTarget(base: Point, m: Player, ballPt: Point, h: Point, bias: number): Point {
  if (bias > 0) {
    const len = Math.hypot(ballPt.x - m.x, ballPt.y - m.y) || 1;
    const f = bias * DENY_SHIFT_FT;
    return { x: base.x + ((ballPt.x - m.x) / len) * f, y: base.y + ((ballPt.y - m.y) / len) * f };
  }
  const len = Math.hypot(h.x - m.x, h.y - m.y) || 1;
  const f = -bias * SAG_SHIFT_FT;
  return { x: base.x + ((h.x - m.x) / len) * f, y: base.y + ((h.y - m.y) / len) * f };
}

/* ---------- HELP STANCE: rotate vs stay (per-defender utility) ----------
   Replaces the resolve-side `chance(rec)` recognition gamble with a per-defender
   UTILITY decision. When the deterministic gates pass (live drive, near the rim,
   driver has BEATEN his man, a help defender is in range), DECIDE emits the `help`
   intent; RESOLVE turns the helper's utility into a rotate-vs-stayhome decision,
   committed ONCE per drive via the helpCommit memo.

   The utility is a rotation PROPENSITY in [0,1] (the helper's utility-weighted
   willingness to rotate). RESOLVE commits it with a single uniform draw (chance) —
   the draw IS the decision noise, and keeping it a one-draw roll preserves the rng
   shape the old gamble used so the neutral baseline is unchanged.

   Utility drivers:
   - my help-defense instinct (helpDefense tendency + IQ + interior D) → rotate
   - I'm the nearest/lowest help defender → rotate (handled by helper selection)
   - threat of the man I'd LEAVE → stay (don't help off a great shooter)
   - coaching: the helpDefense lever is folded into the tendency.
   The instinct terms match the OLD recognition formula (so neutral is preserved);
   the leave-threat term is the genuinely NEW signal (the old code ignored who you
   left). */
const HELP_PROPENSITY_BASE = 0.4; // == old HELP_RECOGNITION_BASE (neutral rotation propensity)
const HELP_IQ_W = 1 / 110; // per IQ point above 60 (matches old rec)
const HELP_INTD_W = 1 / 170; // per interior-D point above 60 (matches old rec)
const HELP_HELP_TEND_W = 1 / 130; // per helpDefense point above 50 (matches old rec → coaching lever)
// The threat of the man the helper would LEAVE pulls his rotation propensity down —
// you do not help off a knock-down shooter (the NEW signal this conversion adds).
// Currently 0: even a small weight measurably LIFTS neutral PPP (helpers decline the
// most valuable kick-out drives, opening rim attacks), which breaks the PPP guardrail.
// Left wired so a future pass can re-enable it once the rim-help loss is offset.
const HELP_LEAVE_THREAT_W = 0.0; // per unit threat of the man left open → stay home (NEW; see note)
const HELP_PROP_MIN = 0.04;
const HELP_PROP_MAX = 0.95;

/* The helper's rotate-vs-stayhome UTILITY, expressed as a commit PROBABILITY in
   [0,1]. RESOLVE rolls it once per drive (single uniform draw → helpCommit memo). */
export function helpRotateUtil(helper: Player, eff: Tendencies): number {
  const leave = helper.assign ? threat(helper.assign) : 0;
  const propensity =
    HELP_PROPENSITY_BASE +
    (helper.attr.iq - 60) * HELP_IQ_W +
    (helper.attr.interiorD - 60) * HELP_INTD_W +
    (eff.helpDefense - 50) * HELP_HELP_TEND_W -
    HELP_LEAVE_THREAT_W * leave;
  return clamp(propensity, HELP_PROP_MIN, HELP_PROP_MAX);
}
// PnR switch is decided PER DEFENDER (not a central matchup rule): under a switch
// scheme each of the two defenders independently weighs taking the switch from the
// matchup it would inherit, how squarely it was screened, and its IQ. A switch
// happens only when BOTH choose it (clean coordination; modelled miscommunication
// is a later step). A coach "switchability" lever will later add to switchWill.
const SWITCH_BASE = 0.6; // baseline willingness to switch a screen
const SWITCH_SIZE_W = 5.0; // willingness lost per foot of height the inherited man has on the defender
const SWITCH_SPEED_W = 0.06; // willingness lost per point of speed the inherited man has on the defender
const SWITCH_CONTACT_W = 0.7; // willingness gained when squarely screened (fighting over is futile)
const SWITCH_IQ_W = 0.012; // per IQ point above 60 (smarter defenders read/commit the switch)
const SCREEN_CONTACT_PERP = 3.2; // ft: screener within this of the defender's path counts as contact

/* ---------- DEFENSE DECIDE (pipeline) ----------
   Pure mirror of defenseMove(): one DecidedIntent per defender encoding the SAME
   target/behavior, but as a returned value — NO mutation of G/.target/.assign, NO
   rng, NO stat/log/transition writes. See docs/decide-pipeline-design.md.

   The helpers reused here (threat, perimeterThreat, offBallDefensiveTarget,
   shouldClearDefensiveLane, matchupDefenseRating, trackingQuality) read live
   Player .x/.y/.vx — safe during DECIDE because nothing mutates this phase. Live
   players are reached via view.ref.

   PRECEDENCE — defenseMove() lets the LAST write to d.target win. For a single
   defender the write order is: man (on/off-ball) → closeout → help → PnR
   drop/hedge. So when several behaviors apply to the same defender, the later one
   in that order is the intent we emit. We build a per-defender map in that exact
   order, overwriting as we go, which reproduces "later write wins". A PnR switch
   writes no target (it swaps assign in RESOLVE), so it never overrides a target
   intent; it is emitted only for the on-ball defender when no later target write
   landed on him. */
export function decideDefense(s: Snapshot): DecidedIntent[] {
  const def = defTeam();
  const off = offTeam();
  const h = hoop();
  const tac = s.tacDef; // == tacFor(opponent) used in defenseMove()
  // bh mirrors `G.ball.holder || G.ball.from` (holder if any, else last passer).
  const bh = G.ball.holder || G.ball.from;
  const presDist = tac.pressure === "tight" ? 1.6 : tac.pressure === "sag" ? 4.5 : 2.8;

  // ----- zone23: each defender spaceTo its ball-shifted anchor (early return) -----
  if (tac.defScheme === "zone23") {
    const dir = G.attackHoop === "R" ? -1 : 1;
    const hh = h;
    const anchors: Point[] = [
      { x: hh.x + dir * 19, y: 18 },
      { x: hh.x + dir * 19, y: 32 }, // top two guards
      { x: hh.x + dir * 9, y: 9 },
      { x: hh.x + dir * 9, y: 41 },
      { x: hh.x + dir * 5, y: 25 },
    ]; // bigs
    const bx = G.ball.x,
      by = G.ball.y;
    return def.map((d, i) => {
      const a = anchors[i];
      const to: Point = { x: lerp(a.x, bx, 0.18), y: lerp(a.y, by, 0.22) };
      return { who: d, intent: { kind: "spaceTo", to } as Intent };
    });
  }

  // Per-defender chosen intent; built in defenseMove write order so later wins.
  const intentFor = new Map<Player, Intent>();

  const LOOKAHEAD = 0.2; // seconds — on-ball lookahead

  // ----- MAN coverage (every assigned defender) -----
  for (const d of def) {
    const m = d.assign;
    if (!m) continue;
    const onBall = m === bh;
    if (onBall) {
      // on-ball: aim at the man's predicted position minus a pressure+sag cushion
      const predX = m.x + m.vx * LOOKAHEAD;
      const predY = m.y + m.vy * LOOKAHEAD;
      const dx = predX - h.x,
        dy = predY - h.y,
        dd = Math.hypot(dx, dy) || 1;
      const depth = dist(m, h);
      const outside = clamp((depth - SAG_MIN_DEPTH) / SAG_DEPTH_RANGE, 0, 1);
      const slow = clamp((SAG_SPEED_PIVOT - d.attr.speed) / 40, 0, 1) * SAG_SLOW_MAX;
      // STANCE CHOICE: scale the formula's sag by the pressure-vs-contain decision.
      const sagScale = onBallSagScale(m, d, s.shotClock, effectiveTendencies(d));
      const sagDist = (SAG_MAX * (1 - perimeterThreat(m)) + slow) * outside * sagScale;
      const cushion = presDist * 0.5 + sagDist;
      // BEATEN OFF THE DRIBBLE: a goal-side stance only holds if the defender can
      // stay in front. When the handler is driving AND has the quickness/handle edge
      // to beat THIS defender (quicknessEdge, the live matchup), the defender gets
      // caught on the hip and trails — he can't sit goal-side. Scale his spot from in
      // front toward a trailing recover-point by how decisively he's beaten and how
      // hard the man is attacking the rim, so a real blow-by shows separation (and the
      // positional help/`onBallBeaten` reads downstream light up on their own). A
      // defender who wins the matchup, or a handler not driving, just holds the front.
      let offset = cushion; // >0 = goal-side (in front); <0 = trailing
      if (G.driving) {
        const driveToRim = (m.vx * -dx + m.vy * -dy) / dd; // ft/s the man is moving rimward
        const intensity = clamp(driveToRim / maxSpeed(m), 0, 1);
        const beat = clamp(quicknessEdge(m, d) * BEAT_EDGE_W, 0, 1) * intensity;
        offset = cushion - beat * (cushion + BEAT_TRAIL); // beat=1 → trail by BEAT_TRAIL
      }
      const to: Point = { x: predX - (dx / dd) * offset, y: predY - (dy / dd) * offset };
      intentFor.set(d, { kind: "contest", manNum: m.num, to });
    } else {
      // off-ball: "on the line, up the line", shifted by the deny-vs-sag STANCE
      // choice, or clear the lane on a 3s warning (lane-clear overrides the stance).
      let to: Point;
      if (shouldClearDefensiveLane(d, off, h)) {
        const side = d.y < 25 ? -1 : 1;
        const dir = G.attackHoop === "R" ? -1 : 1;
        to = { x: h.x + dir * 15, y: side < 0 ? 14 : 36 };
      } else {
        const base = offBallDefensiveTarget(d, m, h);
        const ballPt = { x: G.ball.x, y: G.ball.y };
        const bias = offBallDenyBias(d, m, ballPt, effectiveTendencies(d));
        to = shiftOffBallTarget(base, m, ballPt, h, bias);
      }
      intentFor.set(d, { kind: "contest", manNum: m.num, to });
    }
  }

  // ----- CLOSEOUT ROTATION: nearest defender closes out a wide-open handler -----
  // (defScheme already known non-zone23 here.)
  if (G.ball.holder) {
    const ball = G.ball.holder;
    let nearest: Player | null = null,
      nd = 1e9;
    for (const d of def) {
      const dd = dist(d, ball);
      if (dd < nd) {
        nd = dd;
        nearest = d;
      }
    }
    if (nearest && nd > CLOSEOUT_OPEN_DIST) {
      const dToHoop = dist(ball, h) || 1;
      const ux = (h.x - ball.x) / dToHoop;
      const uy = (h.y - ball.y) / dToHoop;
      const to: Point = {
        x: ball.x + ux * CLOSEOUT_GAP,
        y: clamp(ball.y + uy * CLOSEOUT_GAP, 2, 48),
      };
      intentFor.set(nearest, { kind: "closeout", to });
    }
  }

  // ----- HELP on dribble penetration (4 gates) -----
  // DECIDE emits help only when the DETERMINISTIC gates pass: drive is live,
  // handler is near the rim, the driver has BEATEN his man, and the chosen helper
  // is within helpRadius. The recognition gamble (chance(rec) → helpCommit), the
  // late-rotation catchShoot priming, and the !G.driving clearing of
  // helpCommit/catchShoot are SIDE EFFECTS deferred to RESOLVE (see RESOLVE SPEC).
  // We do NOT gate on helpCommit here (that requires rng); RESOLVE decides commit.
  if (
    G.driving &&
    G.ball.holder &&
    dist(G.ball.holder, h) < 16
  ) {
    const ball = G.ball.holder;
    const onBallD = def.find((d) => d.assign === ball);

    // GATE 1 (beaten)
    const ballToHoop = dist(ball, h);
    const beaten = !onBallD || dist(onBallD, h) > ballToHoop - 0.5 || dist(onBallD, ball) > 3.8;

    let helper: Player | null = null,
      hd = 1e9;
    if (beaten) {
      for (const d of def) {
        if (d === onBallD) continue;
        const dd = dist(d, ball);
        if (dd < hd) {
          hd = dd;
          helper = d;
        }
      }
    }
    if (helper) {
      // GATE 2 (recognition / helpCommit === "in") is the rng gamble → RESOLVE.
      // GATE (range): the wall-up target is geometrically defined regardless; we
      // emit the help intent when the helper is within helpRadius (deterministic).
      const eff = effectiveTendencies(helper);
      const hf = tendencyFactor(eff.helpDefense);
      const helpRadius = 14 * hf;
      // DECIDE emits the help intent whenever the DETERMINISTIC gates pass (in range
      // here). The rotate-vs-stayhome STANCE choice (utility + noise + per-drive
      // commit memo) is made in RESOLVE — keeping the single commit point and all rng
      // in one phase, exactly like the old chance(rec) gamble it replaces.
      if (hd < helpRadius) {
        const bspeed = Math.hypot(ball.vx, ball.vy);
        const distToHoop = dist(ball, h) || 1;
        const hvx = (h.x - ball.x) / distToHoop;
        const hvy = (h.y - ball.y) / distToHoop;
        const rawUx = bspeed > 2 ? ball.vx / bspeed : hvx;
        const rawUy = bspeed > 2 ? ball.vy / bspeed : hvy;
        const dot = rawUx * hvx + rawUy * hvy;
        const ux = dot >= 0 ? rawUx : hvx;
        const uy = dot >= 0 ? rawUy : hvy;
        const commitFrac = clamp(0.28 + hf * 0.22, 0.28, 0.5);
        const stepDist = Math.max(0, distToHoop - 4) * commitFrac;
        const wallX = ball.x + ux * stepDist;
        const wallY = ball.y + uy * stepDist;
        const to: Point = { x: wallX, y: clamp(wallY, 4, 46) };
        // GATE 3 (latency) only primes catchShoot in RESOLVE; no target effect.
        intentFor.set(helper, { kind: "help", driverNum: ball.num, to });
      }
    }
  }

  // ----- PICK & ROLL COVERAGE -----
  // switch: emit switchOnto for the on-ball defender (the assign swap + pnrSwitched
  // flag are RESOLVE effects). drop/hedge: contest at the drop/hedge positioning
  // points (hedge's ball.vx/vy *= 0.85 is a RESOLVE effect — see RESOLVE SPEC).
  let scr: Player | null = null;
  if (G.ball.holder) {
    for (const o of off) {
      if (o !== G.ball.holder && dist(o, G.ball.holder) < 5.5) {
        scr = o;
        break;
      }
    }
  }
  if (scr) {
    const ball = G.ball.holder!;
    const ballD = def.find((d) => d.assign === ball);
    const scrD = def.find((d) => d.assign === scr);
    if (ballD && scrD && ballD !== scrD) {
      const cover = decideScreenCoverage(ballD, scrD, ball, scr, tac);
      if (cover === "switch") {
        // both defenders chose to switch. switchOnto writes no target — ballD keeps
        // guarding the handler this tick (man target from the loop above); the assign
        // swap + pnrSwitched flag are RESOLVE effects (gated by the same decision).
        if (!intentFor.has(ballD)) {
          intentFor.set(ballD, { kind: "switchOnto", manNum: scr.num });
        }
      } else if (cover === "drop") {
        // the screener's defender drops to wall the rim, the ball defender trails.
        intentFor.set(scrD, {
          kind: "contest",
          manNum: scr.num,
          to: { x: lerp(h.x, ball.x, 0.35), y: lerp(h.y, ball.y, 0.35) },
        });
        intentFor.set(ballD, {
          kind: "contest",
          manNum: ball.num,
          to: { x: ball.x + (scr.x - ball.x) * 0.3, y: ball.y + (scr.y - ball.y) * 0.3 },
        });
      } else {
        // hedge
        intentFor.set(scrD, { kind: "contest", manNum: scr.num, to: { x: ball.x, y: ball.y } });
        // ball.vx/vy *= 0.85 → RESOLVE effect (does not change scrD's target).
      }
    }
  }

  // Defenders with no behavior this tick (unassigned, off-ball with no override)
  // already hold a contest intent from the man loop; truly intent-less defenders
  // (no assign and not chosen for closeout/help/PnR) emit hold — matching
  // defenseMove leaving their .target untouched.
  return def.map((d) => ({
    who: d,
    intent: intentFor.get(d) ?? ({ kind: "hold" } as Intent),
  }));
}
