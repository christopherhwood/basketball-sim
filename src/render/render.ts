import { COURT_L, COURT_W, HOOP, ARC_R } from "../core/constants.js";
import { clamp } from "../core/math.js";
import { G, players, hoop, offTeam } from "../core/state.js";
import { tacFor } from "../tactics/tactics.js";
import type { Point } from "../types.js";

/* ---------- 8) RENDER ---------- */
export function createRenderer(canvas: HTMLCanvasElement): () => void {
  const cv = canvas;
  const cx = cv.getContext("2d");
  if (!cx) return () => {};
  const PADX = 18,
    PADY = 14;
  const SX = (cv.width - PADX * 2) / COURT_L,
    SY = (cv.height - PADY * 2) / COURT_W;
  const px = (x: number): number => PADX + x * SX;
  const py = (y: number): number => PADY + y * SY;
  function line(a: Point, b: Point): void {
    cx!.beginPath();
    cx!.moveTo(px(a.x), py(a.y));
    cx!.lineTo(px(b.x), py(b.y));
    cx!.stroke();
  }
  function drawCourt(): void {
    cx!.clearRect(0, 0, cv.width, cv.height);
    cx!.fillStyle = "#0a1416";
    cx!.fillRect(0, 0, cv.width, cv.height);
    cx!.strokeStyle = "#28403f";
    cx!.lineWidth = 1.4;
    cx!.strokeRect(px(0), py(0), COURT_L * SX, COURT_W * SY); // boundary
    line({ x: 47, y: 0 }, { x: 47, y: 50 }); // half
    cx!.beginPath();
    cx!.arc(px(47), py(25), 6 * SX, 0, 7);
    cx!.stroke(); // center circle
    // both ends
    [HOOP.L, HOOP.R].forEach((h) => {
      const dir = h.x < 47 ? 1 : -1;
      // key
      cx!.strokeRect(px(Math.min(h.x, h.x + dir * 19)), py(17), 19 * SX, 16 * SY);
      cx!.beginPath();
      cx!.arc(px(h.x + dir * 19), py(25), 6 * SX, 0, 7);
      cx!.stroke();
      // rim
      cx!.beginPath();
      cx!.arc(px(h.x), py(h.y), 0.9 * SX, 0, 7);
      cx!.strokeStyle = "#3a5a58";
      cx!.stroke();
      cx!.strokeStyle = "#28403f";
      // 3pt line: straight corners (parallel to the sideline) joined by an arc of
      // radius ARC_R centered on the hoop. The straight portions exist because a
      // full-radius arc would run off the corner, so the arc only spans from where
      // it meets each corner line (y = cornerY / COURT_W - cornerY) up to the top.
      const cornerY = 3;
      const sinC = (25 - cornerY) / ARC_R; // sin of the angle where the arc meets a corner
      const thetaC = Math.asin(sinC);
      const tangentX = h.x + dir * Math.cos(thetaC) * ARC_R; // arc/corner join, on both corners
      const baselineX = dir === 1 ? 0 : COURT_L;
      line({ x: baselineX, y: cornerY }, { x: tangentX, y: cornerY });
      line({ x: baselineX, y: COURT_W - cornerY }, { x: tangentX, y: COURT_W - cornerY });
      cx!.beginPath();
      for (let t = -thetaC; t <= thetaC; t += 0.02) {
        const x = h.x + dir * Math.cos(t) * ARC_R,
          y = 25 + Math.sin(t) * ARC_R;
        t === -thetaC ? cx!.moveTo(px(x), py(y)) : cx!.lineTo(px(x), py(y));
      }
      cx!.stroke();
    });
    // highlight which end is being attacked
    const h = hoop();
    cx!.fillStyle = "rgba(244,197,66,.06)";
    cx!.fillRect(px(Math.min(h.x, 47)), py(0), Math.abs(h.x - 47) * SX, COURT_W * SY);
  }
  function drawPlayers(): void {
    for (const p of players()) {
      const col = p.team === "home" ? getCss("--home") : getCss("--away");
      cx!.beginPath();
      cx!.arc(px(p.x), py(p.y), 8, 0, 7);
      cx!.fillStyle = col;
      cx!.globalAlpha = p.hasBall ? 1 : 0.92;
      cx!.fill();
      cx!.globalAlpha = 1;
      if (G.ball.holder === p) {
        cx!.lineWidth = 2;
        cx!.strokeStyle = getCss("--ball");
        cx!.stroke();
      }
      cx!.fillStyle = "#04110f";
      cx!.font = "600 9px IBM Plex Mono";
      cx!.textAlign = "center";
      cx!.textBaseline = "middle";
      cx!.fillText(String(p.num % 100), px(p.x), py(p.y) + 0.5);
    }
    // ball
    cx!.beginPath();
    cx!.arc(px(G.ball.x), py(G.ball.y), 4, 0, 7);
    cx!.fillStyle = getCss("--ball");
    cx!.fill();
  }
  function arrow(from: Point, to: Point): void {
    const ang = Math.atan2(py(to.y) - py(from.y), px(to.x) - px(from.x));
    const hx = px(to.x),
      hy = py(to.y),
      s = 5;
    cx!.beginPath();
    cx!.moveTo(hx, hy);
    cx!.lineTo(hx - s * Math.cos(ang - 0.5), hy - s * Math.sin(ang - 0.5));
    cx!.moveTo(hx, hy);
    cx!.lineTo(hx - s * Math.cos(ang + 0.5), hy - s * Math.sin(ang + 0.5));
    cx!.stroke();
  }
  /* Off-ball action cues: a faint dashed intent line to each mover's target (so
     team movement reads as coordinated, not random), brighter arrows for active
     cut/roll/pop, and a screen "wall" + connector to the handler for the PnR.
     Keyed off persisted p.ob.state / p.target — no engine coupling. */
  function drawActionCues(): void {
    const holder = G.ball.holder;
    const off = offTeam();
    const accent = getCss("--ball");
    cx!.save();
    cx!.strokeStyle = accent;
    for (const p of off) {
      if (p === holder || !p.target) continue;
      const st = p.ob?.state;
      const active = st === "cut" || st === "roll" || st === "pop";
      if (Math.hypot(p.target.x - p.x, p.target.y - p.y) <= 2) continue;
      cx!.globalAlpha = active ? 0.55 : 0.15;
      cx!.lineWidth = active ? 1.6 : 1;
      cx!.setLineDash(active ? [] : [3, 3]);
      line(p, p.target);
      if (active) arrow(p, p.target);
    }
    cx!.setLineDash([]);
    // ball screen: connector handler<->screener + a short wall at the screener
    if (holder) {
      for (const p of off) {
        if (p === holder || p.ob?.state !== "screen") continue;
        cx!.globalAlpha = 0.6;
        cx!.lineWidth = 1.4;
        cx!.setLineDash([2, 2]);
        line(holder, p);
        cx!.setLineDash([]);
        const dx = px(p.x) - px(holder.x),
          dy = py(p.y) - py(holder.y),
          d = Math.hypot(dx, dy) || 1;
        const nx = -dy / d,
          ny = dx / d,
          w = 7;
        cx!.lineWidth = 3;
        cx!.beginPath();
        cx!.moveTo(px(p.x) - nx * w, py(p.y) - ny * w);
        cx!.lineTo(px(p.x) + nx * w, py(p.y) + ny * w);
        cx!.stroke();
      }
    }
    cx!.globalAlpha = 1;
    cx!.setLineDash([]);
    cx!.restore();
  }
  const cssCache: Record<string, string> = {};
  function getCss(v: string): string {
    if (!cssCache[v]) cssCache[v] = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    return cssCache[v];
  }
  return function render(): void {
    drawCourt();
    if (G.ball.state === "held" || G.ball.state === "pass") drawActionCues();
    drawPlayers();
    // active offense + called action (so the live play is legible)
    if (G.ball.state === "held" || G.ball.state === "pass") {
      const tac = tacFor(G.offense);
      cx!.save();
      cx!.globalAlpha = 0.7;
      cx!.fillStyle = G.offense === "home" ? getCss("--home") : getCss("--away");
      cx!.font = "600 10px IBM Plex Mono";
      cx!.textAlign = "left";
      cx!.textBaseline = "top";
      cx!.fillText(
        `${G.offense === "home" ? "HOME" : "AWAY"} BALL · ${tac.action.toUpperCase()}`,
        px(0) + 4,
        py(0) + 4,
      );
      cx!.restore();
    }
    if (G.scoreFlash && G.scoreFlash.t > 0) {
      const s = G.scoreFlash;
      cx!.save();
      cx!.globalAlpha = clamp(s.t / 50, 0, 1);
      cx!.fillStyle = s.team === "home" ? getCss("--home") : getCss("--away");
      cx!.font = "700 26px Anton, sans-serif";
      cx!.textAlign = "center";
      cx!.fillText("+" + s.pts, px(s.x), py(s.y) - 16 - (50 - s.t) * 0.4);
      cx!.beginPath();
      cx!.arc(px(s.x), py(s.y), (52 - s.t) * 0.7, 0, 7);
      cx!.strokeStyle = cx!.fillStyle;
      cx!.lineWidth = 2;
      cx!.stroke();
      cx!.restore();
      s.t--;
    }
    if (G.banner && G.banner.t > 0) {
      const b = G.banner,
        a = clamp(b.t / 22, 0, 1);
      const w = cv.width * 0.62,
        hh = 46,
        x = (cv.width - w) / 2,
        y = cv.height / 2 - hh / 2;
      cx!.save();
      cx!.globalAlpha = a * 0.9;
      cx!.fillStyle = "#0b0e0f";
      cx!.fillRect(x, y, w, hh);
      cx!.globalAlpha = a;
      cx!.strokeStyle = getCss("--ball");
      cx!.lineWidth = 2;
      cx!.strokeRect(x, y, w, hh);
      cx!.fillStyle = getCss("--ball");
      cx!.font = "700 22px Anton, sans-serif";
      cx!.textAlign = "center";
      cx!.textBaseline = "middle";
      cx!.fillText(b.text, cv.width / 2, y + hh / 2 + 1);
      cx!.restore();
      b.t--;
    }
  };
}
