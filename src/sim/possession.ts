import { HOOP, COURT_L, DT } from "../core/constants.js";
import { dist, lerp, clamp } from "../core/math.js";
import { G, offTeam, defTeam, hoop, players, logEv } from "../core/state.js";
import { tacFor } from "../tactics/tactics.js";
import { moveAll, moveTeam } from "./movement.js";
import { offenseDecide, isInsidePlayer } from "./offense.js";
import { defenseMove } from "./defense.js";
import { resolveShot, updateFreeThrows } from "./resolution.js";
import { updateTransition, beginScoreTransition } from "./transition.js";
import { enforceThreeSeconds, resetThreeSecondTimers } from "./threeSeconds.js";
import type { HoopSide, Point, Player } from "../types.js";

/* ---------- POST-SHOT CONVERGENCE CONSTANTS ----------
   While the ball is in the air, all players move to role-appropriate rebound
   positions so the carom-landing distribution is covered by multiple bodies.
   Bigs converge to the paint/blocks; guards/wings converge to the mid-rebound
   band where long caroms and kick-outs land. Defenders box out by holding
   goalside of their man — distributing rather than collapsing onto the rim. */

// Settle beat after a catch: ticks (×0.1s) a catcher waits before his first
// decision. It's a RANGE around a base, shortened by a crisp feed (passer's pass
// rating), the catcher's ball skill (can do something with it immediately), and
// his IQ (reads the floor fast); lengthened by the opposites. Clamped so even an
// elite in-rhythm catch keeps a readable beat and a gather doesn't stall forever.
const SETTLE_BASE = 4.5;
const SETTLE_PASS_W = 0.04; // per pt of passer pass above 70 → quicker (in-rhythm feed)
const SETTLE_HANDLE_W = 0.03; // per pt of catcher handle above 70 → quicker
const SETTLE_IQ_W = 0.03; // per pt of catcher iq above 70 → quicker
const SETTLE_MIN = 3; // 0.3s floor — keeps the offense announceable
const SETTLE_MAX = 7; // 0.7s ceiling — a tough gather
function catchSettle(passer: Player | null | undefined, recv: Player): number {
  const handle = Math.max(recv.attr.handleLeft, recv.attr.handleRight);
  const raw =
    SETTLE_BASE -
    ((passer?.attr.pass ?? 70) - 70) * SETTLE_PASS_W -
    (handle - 70) * SETTLE_HANDLE_W -
    (recv.attr.iq - 70) * SETTLE_IQ_W;
  return clamp(Math.round(raw), SETTLE_MIN, SETTLE_MAX);
}

// Bigs crash to the near-block area
const CONV_BIG_DIST_FROM_HOOP = 6.5;   // ft from hoop for inside rebound position
const CONV_BIG_Y_SPREAD = 10.0;         // half-spread in y; wider spread across carom band

// Guards/wings converge to the perimeter rebound band (long caroms land here)
const CONV_GUARD_DIST_FROM_HOOP = 16.0; // ft from hoop: mid-rebound band
const CONV_GUARD_Y_SPREAD = 13.0;       // half-spread in y; was 11.0 — wider lateral spread

// Defenders box out by sealing slightly rim-side of their assigned man, staying distributed
const CONV_DEF_BOXOUT_OFFSET = 2.8;    // ft toward rim from their man; was 1.8 — stronger box-out

/* Compute a role-appropriate rebound convergence target for one player. */
function reboundConvergeTarget(p: Player, h: Point, dir: number, slotIndex: number): Point {
  const side = slotIndex % 2 === 0 ? -1 : 1; // alternate left/right of lane
  if (isInsidePlayer(p)) {
    return {
      x: clamp(h.x + dir * CONV_BIG_DIST_FROM_HOOP, 1, COURT_L - 1),
      y: clamp(h.y + side * CONV_BIG_Y_SPREAD, 3, 47),
    };
  }
  return {
    x: clamp(h.x + dir * CONV_GUARD_DIST_FROM_HOOP, 1, COURT_L - 1),
    y: clamp(h.y + side * CONV_GUARD_Y_SPREAD, 3, 47),
  };
}

/* Move all players toward role-appropriate rebound zones while a shot is in flight. */
function updateShotFlightConvergence(): void {
  const h = hoop();
  const dir = G.attackHoop === "R" ? -1 : 1;
  const off = offTeam();
  const def = defTeam();

  // offensive players crash toward role-appropriate rebound zones
  let offSlot = 0;
  for (const p of off) {
    if (p.hasBall) continue; // shooter stays put
    p.target = reboundConvergeTarget(p, h, dir, offSlot);
    offSlot++;
  }

  // defenders box out: seal just goalside of their assigned offensive man,
  // staying distributed rather than collapsing everyone onto the rim
  for (const d of def) {
    const man = d.assign;
    if (!man) continue;
    const mx = man.x,
      my = man.y;
    // step from man toward rim by the box-out offset
    const dToH = dist(man, h);
    const stepFrac = dToH > 0.5 ? CONV_DEF_BOXOUT_OFFSET / dToH : 0;
    d.target = {
      x: clamp(lerp(mx, h.x, stepFrac), 1, COURT_L - 1),
      y: clamp(lerp(my, h.y, stepFrac), 3, 47),
    };
  }
}

/* ---------- POSSESSION SETUP ----------
   Reset to a half-court set. Offense's PG gets the ball near the top of
   the key on the attacking side; everyone spaces; defenders match up. */
export function spotsFor(hoopSide: HoopSide): Point[] {
  // 5-out spacing relative to attacking hoop: top, two wings, two corners.
  // Wide spacing is what lets relocation and help-recovery create open looks.
  const h = HOOP[hoopSide],
    dir = hoopSide === "R" ? -1 : 1; // toward midcourt
  return [
    { x: h.x + dir * 23, y: 25 }, // top (handler slot)
    { x: h.x + dir * 19, y: 7 }, // left wing
    { x: h.x + dir * 19, y: 43 }, // right wing
    { x: h.x + dir * 3, y: 3.5 }, // left corner
    { x: h.x + dir * 3, y: 46.5 }, // right corner
  ];
}

export function setupPossession(initial: boolean): void {
  const off = offTeam(),
    def = defTeam();
  const spots = spotsFor(G.attackHoop);
  off.forEach((p, i) => {
    p.x = spots[i].x;
    p.y = spots[i].y;
    p.vx = p.vy = 0;
    p.hasBall = false;
    p.role = i === 0 ? "handler" : i === 4 ? "screener" : "spacer";
    p.ob = { state: "space", t: 0, spot: i }; // off-ball behavior state
  });
  // PG holds ball
  const pg = off[0];
  pg.hasBall = true;
  G.ball.holder = pg;
  G.ball.state = "held";
  G.ball.x = pg.x;
  G.ball.y = pg.y;
  // defense matchup by index, start a step toward their man
  def.forEach((d, i) => {
    d.assign = off[i];
    const m = off[i];
    d.x = lerp(m.x, hoop().x, 0.18);
    d.y = lerp(m.y, hoop().y, 0.18);
    d.vx = d.vy = 0;
  });
  G.shotClock = 24;
  G.possClock = 0;
  G.decideCD = 8;
  G.actionPhase = "bringup";
  G.actionT = 0;
  G.screen = null;
  G.screenerPick = undefined;
  G.ball.state = "held";
  G.pnrSwitched = false;
  G.driving = false;
  G.holdT = 0;
  // clear stale targets from the previous possession so nobody drifts the wrong way
  players().forEach((p) => {
    p.target = { x: p.x, y: p.y };
  });
  resetThreeSecondTimers();
}

/* ---------- 7) POSSESSION + CLOCK ---------- */
export function tick(): void {
  if (G.over) return;
  // free throws: clocks stop, no live AI, just run the sequence and let players settle
  if (G.ball.state === "freethrow") {
    updateFreeThrows();
    moveAll();
    return;
  }
  if (G.ball.state === "transition") {
    updateTransition();
    moveAll();
    // Run clocks only while the ball is live (inpass/outlet/advance).
    // During "score" and "inbound" the game clock is properly stopped.
    const phase = G.trans?.phase;
    if (phase === "inpass" || phase === "outlet" || phase === "advance") {
      G.gameClock -= DT;
      G.shotClock = Math.max(0, G.shotClock - DT);
      G.possClock += DT;
      if (G.gameClock <= 0) {
        endQuarter();
        return;
      }
    }
    return;
  }
  // clocks. The shot clock is floored at 0 so it never reads negative while a
  // shot/pass is in the air (the violation still fires at 0 in a held state).
  G.gameClock -= DT;
  G.shotClock = Math.max(0, G.shotClock - DT);
  G.possClock += DT;
  if (G.gameClock <= 0) {
    endQuarter();
    return;
  }

  // pace affects how quickly the offense looks to shoot (shrinks decide window)
  const tac = tacFor(G.offense);
  void tac;
  // ball flight handling
  if (G.ball.state === "pass") {
    G.ball.flight++;
    const f = clamp(G.ball.flight / (G.ball.passDur as number), 0, 1);
    const r = G.ball.target as Player;
    // Home the ball onto the LIVE (moving) receiver: rotate the heading toward
    // the receiver by at most PASS_MAX_TURN rad/tick so the path stays nearly
    // straight; in the final stretch allow a full turn so the ball lands exactly
    // on the receiver — a clean in-stride catch with no jump. The receiver keeps
    // their own motion (no override), so this is gameplay-neutral.
    const PASS_MAX_TURN = 0.35;
    const turnCap = f > 0.8 ? Math.PI : PASS_MAX_TURN;
    const dxL = r.x - G.ball.x;
    const dyL = r.y - G.ball.y;
    const dL = Math.hypot(dxL, dyL) || 1;
    const curA = Math.atan2(G.ball.hy as number, G.ball.hx as number);
    let delta = Math.atan2(dyL / dL, dxL / dL) - curA;
    if (delta > Math.PI) delta -= 2 * Math.PI;
    if (delta < -Math.PI) delta += 2 * Math.PI;
    delta = clamp(delta, -turnCap, turnCap);
    const newA = curA + delta;
    G.ball.hx = Math.cos(newA);
    G.ball.hy = Math.sin(newA);
    G.ball.x += (G.ball.hx as number) * (G.ball.bspeed as number) * DT;
    G.ball.y += (G.ball.hy as number) * (G.ball.bspeed as number) * DT;
    if (f >= 1) {
      r.hasBall = true;
      G.ball.holder = r;
      G.ball.state = "held";
      G.ball.catchPoint = null;
      G.ball.hx = undefined;
      G.ball.hy = undefined;
      G.ball.bspeed = undefined;
      G.pendingAssist = G.ball.from;
      G.assistCatchT = G.possClock;
      // Settle beat: a catcher surveys before acting instead of instantly swinging
      // the ball along — keeps the offense readable. The beat is a RANGE: a crisp
      // pass from a good passer to a skilled, high-IQ catcher arrives in rhythm
      // (quick action); a sloppy feed to a low-skill player forces a gather (slow).
      G.decideCD = catchSettle(G.ball.from, r);
    }
  } else if (G.ball.state === "shot") {
    G.ball.flight++;
    const f = clamp(G.ball.flight / (G.ball.passDur as number), 0, 1);
    G.ball.x = lerp((G.ball.from as Player).x, hoop().x, f);
    G.ball.y = lerp((G.ball.from as Player).y, hoop().y, f) - Math.sin(f * Math.PI) * 6; // arc
    updateShotFlightConvergence();
    if (f >= 1) {
      resolveShot();
      return;
    }
  } else if (G.ball.state === "held") {
    offenseDecide();
  }
  // a foul during offenseDecide() may have just started a FT sequence this tick
  if (G.ball.state === "freethrow") {
    updateFreeThrows();
    moveAll();
    return;
  }
  if (enforceThreeSeconds()) return;

  if (G.shotClock <= 0 && G.ball.state === "held") {
    logEv(`shot clock violation — ${G.offense === "home" ? "YOU" : "CPU"} turn it over`, "to");
    G.banner = { text: "SHOT CLOCK VIOLATION", t: 115 };
    beginScoreTransition(true);
    return; // dead ball: other team inbounds from the baseline
  }

  // Offense integrates first so defense reads up-to-date offensive positions
  // this tick (eliminates the built-in 0.1 s lag).
  moveTeam(offTeam());
  defenseMove();
  moveTeam(defTeam());
  // ball follows holder after everyone has moved
  if (G.ball.state === "held" && G.ball.holder) {
    G.ball.x = G.ball.holder.x;
    G.ball.y = G.ball.holder.y;
  }
}

function endQuarter(): void {
  if (G.quarter >= 4) {
    G.over = true;
    logEv("— FINAL —", "sc");
    return;
  }
  G.quarter++;
  G.gameClock = G.qLen;
  // teams switch baskets at half
  if (G.quarter === 3) {
    const t = G.homeAttack;
    G.homeAttack = G.awayAttack;
    G.awayAttack = t;
  }
  G.offense = G.quarter % 2 === 0 ? "away" : "home"; // alternate-ish
  G.attackHoop = (G.offense === "home" ? G.homeAttack : G.awayAttack) as HoopSide;
  setupPossession(false);
  logEv(`— end of Q${G.quarter - 1} —`);
}
