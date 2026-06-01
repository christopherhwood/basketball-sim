import { G, offTeam, defTeam, hoop } from "../core/state.js";
import { dist, clamp, lerp } from "../core/math.js";
import { rules } from "../core/rules.js";
import { effectiveTendencies, tendencyFactor } from "./tendency.js";
import type { Player, Point, Tactics } from "../types.js";
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
// Base chance an off-ball defender recognizes a beaten drive and rotates to help.
// IQ, interior defense, and help-defense instinct add to it; poor defenders miss
// the rotation more often. Calibrated so team PPP stays realistic (~1.21).
export const HELP_RECOGNITION_BASE = 0.4;
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
      const sagDist = (SAG_MAX * (1 - perimeterThreat(m)) + slow) * outside;
      const cushion = presDist * 0.5 + sagDist;
      const to: Point = { x: predX - (dx / dd) * cushion, y: predY - (dy / dd) * cushion };
      intentFor.set(d, { kind: "contest", manNum: m.num, to });
    } else {
      // off-ball: "on the line, up the line", or clear the lane on a 3s warning
      const to: Point = shouldClearDefensiveLane(d, off, h)
        ? (() => {
            const side = d.y < 25 ? -1 : 1;
            const dir = G.attackHoop === "R" ? -1 : 1;
            return { x: h.x + dir * 15, y: side < 0 ? 14 : 36 };
          })()
        : offBallDefensiveTarget(d, m, h);
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
      const hf = tendencyFactor(effectiveTendencies(helper).helpDefense);
      const helpRadius = 14 * hf;
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
