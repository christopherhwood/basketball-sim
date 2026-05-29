import { DT } from "../core/constants.js";
import { G, newGame } from "../core/state.js";
import { tick } from "../sim/possession.js";
import { notify } from "./store.js";
import type { Player } from "../types.js";

/* ---------- LOOP ----------
   Decoupled from frame rate. `speed` is a game-time multiplier:
   1x = real time (each tick = DT seconds of game time, 10 ticks/sec).
   We accumulate real elapsed time and run only as many ticks as earned,
   capped per frame so a backgrounded tab can't spiral. */
let running = false,
  speed = 1,
  raf: number | null = null,
  acc = 0,
  lastT = 0;

let renderer: (() => void) | null = null;

export function setRenderer(fn: (() => void) | null): void {
  renderer = fn;
}

function draw(): void {
  if (renderer) renderer();
}

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
    draw();
    notify();
    if (G.over) {
      running = false;
    }
  } else {
    acc = 0;
  }
  raf = requestAnimationFrame(frame);
}

export function startLoop(): void {
  if (!raf) raf = requestAnimationFrame(frame);
}

export function stopLoop(): void {
  if (raf !== null) {
    cancelAnimationFrame(raf);
    raf = null;
  }
}

function play(): void {
  running = true;
  lastT = 0;
  acc = 0;
  notify();
}

function pause(): void {
  running = false;
  lastT = 0;
  acc = 0;
  notify();
}

export function togglePlay(): void {
  if (running) pause();
  else play();
}

export function isRunning(): boolean {
  return running;
}

export function step(): void {
  tick();
  draw();
  notify();
}

export function simToEndOfQuarter(): void {
  const q = G.quarter;
  let guard = 0;
  while (G.quarter === q && !G.over && guard < 200000) {
    tick();
    guard++;
  }
  draw();
  notify();
}

export function setSpeed(n: number): void {
  speed = n;
  notify();
}

export function getSpeed(): number {
  return speed;
}

export function newMatchup(rosters?: { home: Player[]; away: Player[] }): void {
  running = false;
  newGame(Date.now(), rosters);
  G.homeAttack = "R";
  G.awayAttack = "L";
  G.attackHoop = "R";
  draw();
  notify();
}
