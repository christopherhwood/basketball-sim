import { HOOP, COURT_L, DT } from "../core/constants.js";
import { dist, lerp, clamp } from "../core/math.js";
import { G, offTeam, defTeam, hoop, players, logEv } from "../core/state.js";
import { tacFor } from "../tactics/tactics.js";
import { moveAll } from "./movement.js";
import { offenseDecide } from "./offense.js";
import { defenseMove } from "./defense.js";
import { resolveShot, updateFreeThrows } from "./resolution.js";
import { updateTransition, beginScoreTransition } from "./transition.js";
import { enforceThreeSeconds, resetThreeSecondTimers } from "./threeSeconds.js";
import type { HoopSide, Point, Player } from "../types.js";

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
  G.ball.state = "held";
  G.pnrSwitched = false;
  G.driving = false;
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
    return;
  }
  // clocks
  G.gameClock -= DT;
  G.shotClock -= DT;
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
    G.ball.x = lerp((G.ball.from as Player).x, (G.ball.target as Player).x, f);
    G.ball.y = lerp((G.ball.from as Player).y, (G.ball.target as Player).y, f);
    if (f >= 1) {
      const r = G.ball.target as Player;
      r.hasBall = true;
      G.ball.holder = r;
      G.ball.state = "held";
      G.pendingAssist = G.ball.from;
      G.decideCD = 3;
    }
  } else if (G.ball.state === "shot") {
    G.ball.flight++;
    const f = clamp(G.ball.flight / (G.ball.passDur as number), 0, 1);
    G.ball.x = lerp((G.ball.from as Player).x, hoop().x, f);
    G.ball.y = lerp((G.ball.from as Player).y, hoop().y, f) - Math.sin(f * Math.PI) * 6; // arc
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

  defenseMove();
  moveAll();
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
