import type { Coaching, PlayerCoaching } from "../types.js";

export const NEUTRAL_PLAYER_COACHING: PlayerCoaching = {
  shotFreedom: "normal",
  shotBias: "balanced",
  playmaking: "balanced",
  reboundRole: "balanced",
  aggression: "balanced",
  help: "balanced",
};

export const coaching: Coaching = { perPlayer: {} };

export function playerCoaching(num: number): PlayerCoaching {
  return coaching.perPlayer[num] ?? NEUTRAL_PLAYER_COACHING;
}

export function setPlayerCoaching(num: number, c: PlayerCoaching): void {
  coaching.perPlayer[num] = c;
}

export function resetCoaching(): void {
  coaching.perPlayer = {};
}
