import { G, offTeam, defTeam, hoop } from "../core/state.js";
import { dist, clamp, lerp } from "../core/math.js";
import { tacFor } from "../tactics/tactics.js";
import type { Player, Tactics } from "../types.js";

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

  // MAN defense
  for (const d of def) {
    const m = d.assign;
    if (!m) {
      continue;
    }
    const onBall = m === bh;
    let gap = onBall ? presDist : 3 + (1 - threat(m)) * 3; // sag off non-shooters
    // position between man and basket
    let tx = lerp(m.x, h.x, gap / Math.max(dist(m, h), 1));
    let ty = lerp(m.y, h.y, gap / Math.max(dist(m, h), 1));
    d.target = { x: m.x + (h.x - m.x) * 0.16 * (onBall ? 0.6 : 1), y: m.y + (h.y - m.y) * 0.16 * (onBall ? 0.6 : 1) };
    // keep on-ball defender right on the handler at the pressure distance
    if (onBall) {
      const dx = m.x - h.x,
        dy = m.y - h.y,
        dd = Math.hypot(dx, dy) || 1;
      d.target = { x: m.x - (dx / dd) * presDist * 0.5, y: m.y - (dy / dd) * presDist * 0.5 };
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
    if (helper && hd < 14) helper.target = { x: lerp(ball.x, h.x, 0.45), y: lerp(ball.y, h.y, 0.45) };
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
