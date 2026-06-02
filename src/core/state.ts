import { HOOP } from "./constants.js";
import { seedRng } from "./rng.js";
import { resetNamePool, genTeam } from "../data/roster.js";
import { setupPossession } from "../sim/possession.js";
import type { GameState, Player, TeamSide, Point } from "../types.js";

/* ---------- GAME STATE ---------- */
export let G: GameState;

export function newGame(seed?: number, rosters?: { home: Player[]; away: Player[] }): void {
  if (seed !== undefined) seedRng(seed);
  resetNamePool();
  G = {
    home: rosters ? rosters.home : genTeam("home"),
    away: rosters ? rosters.away : genTeam("away"),
    offense: "home", // which team has the ball
    attackHoop: "R", // home attacks R first
    ball: { x: HOOP.L.x, y: 25, state: "inbound", holder: null, target: null, flight: 0, shotMeta: null },
    score: { home: 0, away: 0 },
    quarter: 1,
    qLen: 12 * 60,
    gameClock: 12 * 60,
    shotClock: 24,
    possClock: 0,
    decideCD: 0,
    over: false,
    feed: [],
  };
  // assign defensive matchups (man) by lineup index
  setupPossession(true);
}

export function players(): Player[] {
  return G.home.concat(G.away);
}
function teamArr(t: TeamSide): Player[] {
  return t === "home" ? G.home : G.away;
}
export function offTeam(): Player[] {
  return teamArr(G.offense);
}
export function defTeam(): Player[] {
  return teamArr(G.offense === "home" ? "away" : "home");
}
export function hoop(): Point {
  return HOOP[G.attackHoop];
}

let feedSeq = 0;
export function logEv(t: string, cls?: string): void {
  G.feed.unshift({ id: feedSeq++, t, cls });
  if (G.feed.length > 60) G.feed.pop();
}
