import { G, offTeam, defTeam, hoop } from "../core/state.js";
import { dist, clamp, lerp } from "../core/math.js";
import { rules } from "../core/rules.js";
import { tacFor } from "../tactics/tactics.js";
import { effectiveTendencies, tendencyFactor } from "./tendency.js";
import type { Player, Point, Tactics } from "../types.js";

const LANE_MIN_Y = 17;
const LANE_MAX_Y = 33;
const LANE_DEPTH_FROM_HOOP = 13.75;
const DEF_LANE_CLEAR_WARN_T = 1.5;
const DEF_LANE_LOW_IQ_EXTRA_T = 1.0;
const OFFBALL_TRACK_LAG_MAX = 4.8;
const OFFBALL_TRACK_SPEED_START = 2.5;
const OFFBALL_TRACK_SPEED_RANGE = 11;

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

/* ---------- DEFENSE AI ---------- */
export function defenseMove(): void {
  const def = defTeam(),
    off = offTeam(),
    h = hoop(),
    tac = tacFor(G.offense === "home" ? "away" : "home");
  const bh = G.ball.holder || G.ball.from;
  const presDist = tac.pressure === "tight" ? 1.6 : tac.pressure === "sag" ? 4.5 : 2.8;

  if (tac.defScheme === "zone23") {
    // 2-3 zone: anchor points relative to defended hoop, shifted toward ball
    const dir = G.attackHoop === "R" ? -1 : 1,
      hh = h;
    const anchors = [
      { x: hh.x + dir * 19, y: 18 },
      { x: hh.x + dir * 19, y: 32 }, // top two guards
      { x: hh.x + dir * 9, y: 9 },
      { x: hh.x + dir * 9, y: 41 },
      { x: hh.x + dir * 5, y: 25 },
    ]; // bigs
    def.forEach((d, i) => {
      const a = anchors[i];
      const bx = G.ball.x,
        by = G.ball.y;
      d.target = { x: lerp(a.x, bx, 0.18), y: lerp(a.y, by, 0.22) };
      // closest offensive player inside this defender's region gets contested
    });
    return;
  }

  // On-ball lookahead: aim for where the handler will be, not where he is.
  const LOOKAHEAD = 0.2; // seconds

  // MAN defense
  for (const d of def) {
    const m = d.assign;
    if (!m) {
      continue;
    }
    const onBall = m === bh;
    d.target = onBall
      ? {
          x: m.x + (h.x - m.x) * 0.16 * 0.6,
          y: m.y + (h.y - m.y) * 0.16 * 0.6,
        }
      : offBallDefensiveTarget(d, m, h);
    // keep on-ball defender at the pressure distance, aimed at the man's
    // predicted position so the defender meets a driver instead of trailing
    if (onBall) {
      const predX = m.x + m.vx * LOOKAHEAD;
      const predY = m.y + m.vy * LOOKAHEAD;
      const dx = predX - h.x,
        dy = predY - h.y,
        dd = Math.hypot(dx, dy) || 1;
      d.target = { x: predX - (dx / dd) * presDist * 0.5, y: predY - (dy / dd) * presDist * 0.5 };
    }
    if (!onBall && shouldClearDefensiveLane(d, off, h)) {
      const side = d.y < 25 ? -1 : 1;
      const dir = G.attackHoop === "R" ? -1 : 1;
      d.target = { x: h.x + dir * 15, y: side < 0 ? 14 : 36 };
    }
  }

  // HELP on dribble penetration: the nearest off-ball defender steps in to wall
  // up the driver, leaving his man. When the drive ends, G.driving goes false and
  // he recovers (a closeout that takes time), briefly opening the kick-out target.
  if ((tac.defScheme as Tactics["defScheme"]) !== "zone23" && G.driving && G.ball.holder && dist(G.ball.holder, h) < 16) {
    const ball = G.ball.holder;
    const onBallD = def.find((d) => d.assign === ball);
    let helper: Player | null = null,
      hd = 1e9;
    for (const d of def) {
      if (d === onBallD) continue;
      const dd = dist(d, ball);
      if (dd < hd) {
        hd = dd;
        helper = d;
      }
    }
    if (helper) {
      const hf = tendencyFactor(effectiveTendencies(helper).helpDefense);
      const helpRadius = 14 * hf;
      if (hd < helpRadius) {
        const bspeed = Math.hypot(ball.vx, ball.vy);
        const distToHoop = dist(ball, h) || 1;
        const hvx = (h.x - ball.x) / distToHoop;
        const hvy = (h.y - ball.y) / distToHoop;
        const rawUx = bspeed > 2 ? ball.vx / bspeed : hvx;
        const rawUy = bspeed > 2 ? ball.vy / bspeed : hvy;
        // if velocity points away from hoop (misdirection), fall back to hoop direction
        const dot = rawUx * hvx + rawUy * hvy;
        const ux = dot >= 0 ? rawUx : hvx;
        const uy = dot >= 0 ? rawUy : hvy;
        const commitFrac = clamp(0.28 + hf * 0.22, 0.28, 0.50);
        const stepDist = Math.max(0, distToHoop - 4) * commitFrac;
        const wallX = ball.x + ux * stepDist;
        const wallY = ball.y + uy * stepDist;
        helper.target = { x: wallX, y: clamp(wallY, 4, 46) };
      }
    }
  }

  // PICK & ROLL COVERAGE — only when a teammate is PHYSICALLY setting a screen
  // on the ball (within ~5.5 ft). Two players just passing are not a screen.
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
      if (tac.pnr === "switch") {
        // swap ONCE per screen; the flag stops it flip-flopping every tick
        if (!G.pnrSwitched) {
          ballD.assign = scr;
          scrD.assign = ball;
          G.pnrSwitched = true;
        }
      } else if (tac.pnr === "drop") {
        scrD.target = { x: lerp(h.x, ball.x, 0.35), y: lerp(h.y, ball.y, 0.35) };
        ballD.target = { x: ball.x + (scr.x - ball.x) * 0.3, y: ball.y + (scr.y - ball.y) * 0.3 };
      } else if (tac.pnr === "hedge") {
        scrD.target = { x: ball.x, y: ball.y };
        ball.vx *= 0.85;
        ball.vy *= 0.85;
      }
    }
  } else {
    G.pnrSwitched = false;
  } // screen has dispersed; a future screen may switch again
}

export function threat(p: Player): number {
  // 0..1 how much you must respect this man
  return clamp((p.attr.three * 0.6 + p.attr.mid * 0.2 + p.attr.finishing * 0.2 - 40) / 55, 0, 1);
}
