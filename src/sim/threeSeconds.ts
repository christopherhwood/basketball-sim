import { DT } from "../core/constants.js";
import { dist } from "../core/math.js";
import { rules } from "../core/rules.js";
import { G, defTeam, hoop, logEv, offTeam, players } from "../core/state.js";
import { beginScoreTransition } from "./transition.js";
import type { Player, Point } from "../types.js";

const LANE_MIN_Y = 17;
const LANE_MAX_Y = 33;
const LANE_DEPTH_FROM_HOOP = 13.75;
const CUT_EXEMPT_T = 2.7;
const LEAVING_GRACE_T = 2.7;

function inLane(p: Point, h: Point): boolean {
  return Math.abs(p.x - h.x) <= LANE_DEPTH_FROM_HOOP && p.y >= LANE_MIN_Y && p.y <= LANE_MAX_Y;
}

export function resetThreeSecondTimers(): void {
  for (const p of players()) {
    p.offLaneT = 0;
    p.defLaneT = 0;
  }
}

function bestTechnicalShooter(off: Player[]): Player {
  let best = off[0];
  for (const p of off) {
    if (p.attr.mid > best.attr.mid) best = p;
  }
  return best;
}

function awardDefensiveThreeSeconds(off: Player[]): void {
  const shooter = bestTechnicalShooter(off);
  shooter.stats.fta++;
  shooter.stats.ftm++;
  shooter.stats.pts++;
  G.score[shooter.team]++;
  G.scoreFlash = { x: hoop().x, y: hoop().y, pts: 1, team: shooter.team, t: 45 };
  G.banner = { text: "DEFENSIVE 3 SECONDS", t: 100 };
  logEv(`defensive three seconds — ${shooter.name} makes the technical free throw`, "sc");
}

export function enforceThreeSeconds(): boolean {
  if (G.ball.state !== "held" && G.ball.state !== "pass") return false;

  const off = offTeam();
  const def = defTeam();
  const h = hoop();

  if (rules.offensiveThreeSeconds) {
    for (const p of off) {
      const attacking = G.ball.holder === p && G.driving;
      const activeCut = p.ob?.state === "cut" && p.ob.t <= CUT_EXEMPT_T;
      const leavingLane = !!p.target && !inLane(p.target, h);
      if (inLane(p, h) && !attacking && !activeCut && !(leavingLane && (p.offLaneT ?? 0) < LEAVING_GRACE_T)) {
        p.offLaneT = (p.offLaneT ?? 0) + DT;
      } else {
        p.offLaneT = Math.max(0, (p.offLaneT ?? 0) - DT);
      }
      if (p.offLaneT > rules.threeSecondLimit) {
        p.stats.tov++;
        G.banner = { text: "OFFENSIVE 3 SECONDS", t: 100 };
        logEv(`${p.name} is called for offensive three seconds — turnover`, "to");
        resetThreeSecondTimers();
        // dead ball: the other team inbounds (same path as a shot-clock violation)
        beginScoreTransition(true);
        return true;
      }
    }
  }

  if (rules.defensiveThreeSeconds) {
    for (const d of def) {
      const activelyGuarding = off.some((p) => dist(d, p) <= rules.defensiveThreeSecondsGuardingDistance);
      const leavingLane = !!d.target && !inLane(d.target, h);
      if (inLane(d, h) && !activelyGuarding && !(leavingLane && (d.defLaneT ?? 0) < LEAVING_GRACE_T)) {
        d.defLaneT = (d.defLaneT ?? 0) + DT;
      } else {
        d.defLaneT = Math.max(0, (d.defLaneT ?? 0) - DT);
      }
      if (d.defLaneT > rules.threeSecondLimit) {
        awardDefensiveThreeSeconds(off);
        for (const p of def) p.defLaneT = 0;
        return false;
      }
    }
  }

  return false;
}
