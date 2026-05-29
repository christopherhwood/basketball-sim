import { COURT_L, COURT_W, DT } from "../core/constants.js";
import { clamp } from "../core/math.js";
import { G, players } from "../core/state.js";
import type { Player } from "../types.js";

/* ---------- 3) MOVEMENT ----------
   steer each player toward p.target up to a max speed from Speed attr,
   with light acceleration so motion looks natural, not teleporting. */
export function maxSpeed(p: Player): number {
  return (10 + ((p.attr.speed - 50) / 50) * 8) * (1 - p.fatigue * 0.18);
}

// Arrive tuning: within ARRIVE_SLOW_R the desired speed ramps linearly to zero;
// inside ARRIVE_STOP_R the player is treated as arrived. Replaces a hard 0.6 ft
// dead-zone that let fast movers overshoot and oscillate.
const ARRIVE_SLOW_R = 4.0; // ft: begin decelerating within this radius
const ARRIVE_STOP_R = 0.3; // ft: zero desired speed inside this

export function moveAll(): void {
  for (const p of players()) {
    if (!p.target) {
      p.vx *= 0.7;
      p.vy *= 0.7;
    } else {
      const ms = maxSpeed(p);
      const dx = p.target.x - p.x,
        dy = p.target.y - p.y,
        d = Math.hypot(dx, dy) || 1;
      // Arrive: ramp the desired speed down within a slowing radius so a fast
      // player decelerates INTO the target instead of blowing past the old hard
      // 0.6 ft dead-zone and reversing every tick (the visible wobble).
      const desv = d < ARRIVE_STOP_R ? 0 : ms * Math.min(1, d / ARRIVE_SLOW_R);
      const dvx = (dx / d) * desv,
        dvy = (dy / d) * desv,
        acc = ms * 4;
      p.vx += clamp(dvx - p.vx, -acc * DT, acc * DT);
      p.vy += clamp(dvy - p.vy, -acc * DT, acc * DT);
      // bleed residual velocity right at the target to kill micro-oscillation
      if (d < ARRIVE_STOP_R * 2) {
        p.vx *= 0.5;
        p.vy *= 0.5;
      }
    }
    p.x = clamp(p.x + p.vx * DT, 1, COURT_L - 1);
    p.y = clamp(p.y + p.vy * DT, 1, COURT_W - 1);
    p.fatigue = clamp(p.fatigue + (Math.hypot(p.vx, p.vy) > 6 ? 0.0006 : -0.0004), 0, 1);
  }
  // ball follows holder
  if (G.ball.state === "held" && G.ball.holder) {
    G.ball.x = G.ball.holder.x;
    G.ball.y = G.ball.holder.y;
  }
}
