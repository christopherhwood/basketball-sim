import { G } from "../core/state.js";
import type { Player } from "../types.js";

export function fmtClock(s: number): string {
  const m = Math.floor(s / 60),
    sec = Math.floor(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
}

export function row(p: Player): string {
  const s = p.stats;
  return (
    `<tr><td class="name">${p.num} ${p.name}</td><td>${s.pts}</td>` +
    `<td>${s.fgm}-${s.fga}</td><td>${s.tpm}-${s.tpa}</td><td>${s.ftm}-${s.fta}</td>` +
    `<td>${s.reb}</td><td>${s.ast}</td><td>${s.stl}</td><td>${s.tov}</td></tr>`
  );
}

export function updateUI(): void {
  document.getElementById("homePts")!.textContent = String(G.score.home);
  document.getElementById("awayPts")!.textContent = String(G.score.away);
  document.getElementById("gameClock")!.textContent = fmtClock(G.gameClock);
  document.getElementById("shotClock")!.textContent =
    ":" + String(Math.ceil(G.shotClock)).padStart(2, "0");
  document.getElementById("qLbl")!.textContent = G.over ? "FINAL" : "Q" + G.quarter;
  document.getElementById("possLbl")!.textContent =
    "possession: " + (G.offense === "home" ? "YOU" : "CPU");
  document.getElementById("homeBox")!.innerHTML = G.home.map(row).join("");
  document.getElementById("awayBox")!.innerHTML = G.away.map(row).join("");
  document.getElementById("feed")!.innerHTML = G.feed
    .map(
      (e) =>
        `<div class="ev ${e.cls ? (e.cls === "sc" ? "sc-ev" : "to-ev") : ""}">${e.t}</div>`,
    )
    .join("");
}
