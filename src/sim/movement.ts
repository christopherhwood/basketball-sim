import { COURT_L, COURT_W, DT } from "../core/constants.js";
import { clamp } from "../core/math.js";
import { G, players } from "../core/state.js";
import type { Player, Point } from "../types.js";

/* ---------- 3) MOVEMENT ----------
   steer each player toward p.target up to a max speed from Speed attr,
   with light acceleration so motion looks natural, not teleporting. */
// Top speed in ft/s. Calibrated toward NBA tracking: an average athlete (speed
// 50) sustains ~13 ft/s (~9 mph) in a possession, an elite one (speed 100) tops
// out ~24 ft/s (~16 mph sprint). Previously 10–18 ft/s, which left defenders
// nearly as fast as a thrown pass (~17 ft/s) and made the floor play sluggishly.
export function maxSpeed(p: Player): number {
  return (13 + ((p.attr.speed - 50) / 50) * 11) * (1 - p.fatigue * 0.18);
}

// Arrive tuning: within ARRIVE_SLOW_R the desired speed ramps linearly to zero;
// inside ARRIVE_STOP_R the player is treated as arrived. Replaces a hard 0.6 ft
// dead-zone that let fast movers overshoot and oscillate.
const ARRIVE_SLOW_R = 4.0; // ft: begin decelerating within this radius
const ARRIVE_STOP_R = 0.3; // ft: zero desired speed inside this

const SEP_RADIUS = 3.5; // ft; same-team players within this distance trigger repulsion
const SEP_WEIGHT = 0.4; // fraction of maxSpeed applied as max separation magnitude

function separationDelta(p: Player, ms: number): [number, number] {
  if (p.hasBall) return [0, 0];
  let sx = 0,
    sy = 0;
  for (const other of players()) {
    if (other === p || other.team !== p.team) continue;
    const odx = p.x - other.x,
      ody = p.y - other.y;
    const od = Math.hypot(odx, ody) || 1;
    if (od < SEP_RADIUS) {
      const strength = (SEP_RADIUS - od) / SEP_RADIUS;
      sx += (odx / od) * strength;
      sy += (ody / od) * strength;
    }
  }
  const rawSep = Math.hypot(sx, sy);
  const sepCap = ms * SEP_WEIGHT;
  const scale = rawSep > 0 ? Math.min(rawSep * ms, sepCap) / rawSep : 0;
  return [sx * scale, sy * scale];
}

export function moveTeam(team: Player[]): void {
  for (const p of team) {
    const ms = maxSpeed(p);
    if (!p.target) {
      p.vx *= 0.7;
      p.vy *= 0.7;
      const [sx, sy] = separationDelta(p, ms);
      p.vx += sx * DT;
      p.vy += sy * DT;
    } else {
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
      const [sx, sy] = separationDelta(p, ms);
      p.vx += clamp(dvx + sx - p.vx, -acc * DT, acc * DT);
      p.vy += clamp(dvy + sy - p.vy, -acc * DT, acc * DT);
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
}

export function moveAll(): void {
  moveTeam(players());
  // ball follows holder
  if (G.ball.state === "held" && G.ball.holder) {
    G.ball.x = G.ball.holder.x;
    G.ball.y = G.ball.holder.y;
  }
}

/* ---------- PHYSICAL SCREEN CONTACT ----------
   The screen is a BODY, not a magic bonus. While the designated screener is set on
   the ball (within SCREEN_CONTACT_DIST of the on-ball defender), the on-ball
   defender cannot run through the screener's body and is SLOWED navigating around
   it — so he lags the handler and the handler gets real separation. The separation
   then naturally improves the handler's look through the existing proximity-keyed
   contest math (no DRIVE_SCREEN_BONUS needed).

   Deterministic, rng-free, position-based. Runs in ACT after both teams have moved.

   Scaling:
   - screen quality  = screener strength + screen rating (how hard the pick is)
   - nav quality     = defender perimD + iq + speed (how well he fights through)
   - scheme:
       SWITCH        → no impediment (coverage swaps; screener's man takes handler)
       DROP          → defender goes UNDER: light impediment (he trails → concedes pull-up)
       fight-over    → full impediment (most hung up) */
const SCREEN_BODY_RADIUS = 1.2; // ft: the screener's body the defender can't overlap
const SCREEN_CONTACT_DIST = 2.4; // ft: screener within this of the on-ball defender = body contact (impediment)
const SCREEN_SET_NEAR_BALL = 4.5; // ft: screener within this of the handler = pick is SET at the point of attack
// Retained pursuit velocity for a fight-over defender hung up on the pick: an even
// matchup keeps SCREEN_SLOW_BASE of his speed; a harder screen (screenQ > navQ)
// retains LESS (slows more), a great navigator retains more. Clamped to a band.
const SCREEN_SLOW_BASE = 0.78; // velocity retained by an evenly-matched hung-up defender (lower = slower)
const SCREEN_SLOW_ABILITY_W = 1 / 320; // per (screenQ - navQ) point: harder pick → slower
const SCREEN_SLOW_MIN = 0.6; // floor on retained velocity (a great screen still doesn't freeze him in the lane)
const SCREEN_SLOW_MAX = 0.92; // ceiling (a great navigator barely loses a step)
const SCREEN_DROP_SLOW = 0.8; // going UNDER (drop coverage): he slides under but the pick still costs him a step → trails

export type ScreenScheme = "switch" | "drop" | "fight";

export interface ActiveScreen {
  screener: Player; // the body
  onBallDef: Player; // the defender being impeded (assign === handler)
  handler: Player; // the ball-handler the pick is set for
  scheme: ScreenScheme;
  screenQ: number; // how hard the pick is (strength + screen tendency)
  navQ: number; // how well the defender fights through (perimD + iq + speed)
}

/* Apply the physical impediment for one active set screen. Returns true if the pick
   is SET this tick — the screener has arrived at the point of attack (near the
   handler) so the handler can use it. The SET is a positional fact (it holds even
   when a drop defender slides under without bumping the body); the IMPEDIMENT (detour
   + slow) only applies on actual body contact with the on-ball defender and is
   skipped for a switch (the coverage swaps instead). */
export function resolveScreenContact(scr: ActiveScreen): boolean {
  const { screener, onBallDef, scheme, handler } = scr;
  const dx = onBallDef.x - screener.x;
  const dy = onBallDef.y - screener.y;
  const d = Math.hypot(dx, dy) || 1;
  // SET: the pick has arrived at the point of attack — screener near the on-ball
  // defender OR near the handler (the ball). Positional; true even in a clean under.
  const distToHandler = Math.hypot(handler.x - screener.x, handler.y - screener.y);
  const isSet = d < SCREEN_CONTACT_DIST || distToHandler < SCREEN_SET_NEAR_BALL;
  if (!isSet) return false;
  // a switch has no navigation to impede — the screener's man simply takes the handler.
  if (scheme === "switch") return true;
  // body impediment only when the defender is actually on the screener's body.
  if (d >= SCREEN_CONTACT_DIST) return true;

  // 1) DETOUR: never let the defender overlap the screener's body. If he's inside
  //    the body radius, push him out along the screener→defender axis (he must go
  //    AROUND the pick, not through it). This is the continuous-collision-style
  //    correction that makes the screen a wall.
  if (d < SCREEN_BODY_RADIUS) {
    const push = (SCREEN_BODY_RADIUS - d) / d;
    onBallDef.x = clamp(onBallDef.x + dx * push, 1, COURT_L - 1);
    onBallDef.y = clamp(onBallDef.y + dy * push, 1, COURT_W - 1);
    // bleed the velocity component INTO the screener (he can't keep driving through it)
    const nx = dx / d,
      ny = dy / d;
    const into = onBallDef.vx * -nx + onBallDef.vy * -ny; // toward screener if positive
    if (into > 0) {
      onBallDef.vx += nx * into;
      onBallDef.vy += ny * into;
    }
  }

  // 2) SLOW: scale his pursuit velocity. A drop defender went under → only a light
  //    brush; a fight-over defender is most hung up, scaled by screen vs nav ability.
  let retain: number;
  if (scheme === "drop") {
    retain = SCREEN_DROP_SLOW;
  } else {
    retain = clamp(
      SCREEN_SLOW_BASE - (scr.screenQ - scr.navQ) * SCREEN_SLOW_ABILITY_W,
      SCREEN_SLOW_MIN,
      SCREEN_SLOW_MAX,
    );
  }
  onBallDef.vx *= retain;
  onBallDef.vy *= retain;
  return true;
}

/* Geometry helper: signed distance the on-ball defender trails the handler along
   the handler→hoop axis (positive = defender is BEHIND the handler, i.e. beaten /
   separated). Used to detect that the handler came off the pick (roll/pop trigger). */
export function defenderTrail(handler: Player, onBallDef: Player, hoopPt: Point): number {
  const ux = hoopPt.x - handler.x;
  const uy = hoopPt.y - handler.y;
  const len = Math.hypot(ux, uy) || 1;
  // defender position relative to handler, projected onto handler→hoop axis.
  // negative projection = defender is behind the handler (handler is ahead toward rim).
  return -((onBallDef.x - handler.x) * (ux / len) + (onBallDef.y - handler.y) * (uy / len));
}
