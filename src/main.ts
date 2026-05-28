import { DT } from "./core/constants.js";
import { G, newGame } from "./core/state.js";
import { tick } from "./sim/possession.js";
import { render } from "./render/render.js";
import { updateUI } from "./ui/ui.js";
import { tactics } from "./tactics/tactics.js";
import { loadLeagueFromGlob } from "./data/leagueBrowser.js";
import { teamToEnginePlayers } from "./data/playerData.js";
import type { Tactics } from "./types.js";

/* ---------- 9) LOOP ----------
   Decoupled from frame rate. `speed` is a game-time multiplier:
   1x = real time (each tick = DT seconds of game time, 10 ticks/sec).
   We accumulate real elapsed time and run only as many ticks as earned,
   capped per frame so a backgrounded tab can't spiral. */
let running = false,
  speed = 1,
  raf: number | null = null,
  acc = 0,
  lastT = 0;

function frame(ts: number): void {
  if (!lastT) lastT = ts;
  const dtReal = (ts - lastT) / 1000;
  lastT = ts;
  if (running) {
    acc += dtReal * speed; // game-seconds to advance this frame
    let budget = 0;
    while (acc >= DT && budget < 300) {
      tick();
      acc -= DT;
      budget++;
      if (G.over) break;
    }
    render();
    updateUI();
    if (G.over) {
      running = false;
      playBtn.textContent = "▶ play";
    }
  } else {
    acc = 0;
  }
  raf = requestAnimationFrame(frame);
}
function start(): void {
  if (!raf) raf = requestAnimationFrame(frame);
}

const playBtn = document.getElementById("play") as HTMLButtonElement;
playBtn.onclick = (e: MouseEvent) => {
  running = !running;
  lastT = 0;
  acc = 0;
  (e.target as HTMLButtonElement).textContent = running ? "❚❚ pause" : "▶ play";
};
(document.getElementById("step") as HTMLButtonElement).onclick = () => {
  tick();
  render();
  updateUI();
};
(document.getElementById("ff") as HTMLButtonElement).onclick = () => {
  const q = G.quarter;
  let guard = 0;
  while (G.quarter === q && !G.over && guard < 200000) {
    tick();
    guard++;
  }
  render();
  updateUI();
};
(document.getElementById("reset") as HTMLButtonElement).onclick = () => {
  running = false;
  playBtn.textContent = "▶ play";
  G.homeAttack = "R";
  G.awayAttack = "L";
  newGameWrap();
};
document.querySelectorAll<HTMLButtonElement>(".speed button").forEach((b) => (b.onclick = () => (speed = +b.dataset.sp!)));

document.querySelectorAll<HTMLElement>(".opts").forEach((grp) => {
  grp.querySelectorAll<HTMLElement>(".opt").forEach(
    (o) =>
      (o.onclick = () => {
        grp.querySelectorAll<HTMLElement>(".opt").forEach((x) => x.classList.remove("on"));
        o.classList.add("on");
        const key = grp.dataset.set as keyof Tactics;
        (tactics[key] as string) = o.dataset.v!;
      }),
  );
});

function newGameWrap(): void {
  const { teams } = loadLeagueFromGlob();
  if (teams.length >= 2) {
    const home = teamToEnginePlayers(teams[0], "home");
    const away = teamToEnginePlayers(teams[1], "away");
    newGame(Date.now(), { home, away });
  } else {
    newGame(Date.now());
  }
  G.homeAttack = "R";
  G.awayAttack = "L";
  G.attackHoop = "R";
  render();
  updateUI();
}
newGameWrap();
start();
