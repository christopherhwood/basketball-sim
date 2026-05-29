import type { Player, Tendencies } from "../types.js";
import { playerCoaching } from "../coaching/coaching.js";

export const DEFAULT_TENDENCIES: Tendencies = {
  shootThree: 50,
  shootMid: 50,
  driveRim: 50,
  pass: 50,
  postUp: 50,
  screen: 50,
  helpDefense: 50,
  gambleSteal: 50,
  crashGlass: 50,
  pushTransition: 50,
};

export function tendenciesOf(p: Player): Tendencies {
  return p.tendencies ?? DEFAULT_TENDENCIES;
}

/**
 * Canonical 0..100 -> multiplier mapping used by decision code to scale
 * utilities/chances. 50 is neutral (factor 1.0): 0 -> 0.5, 50 -> 1.0, 100 -> 1.5.
 */
export function tendencyFactor(value: number): number {
  return 0.5 + value / 100;
}

function clamp01_100(v: number): number {
  return v < 0 ? 0 : v > 100 ? 100 : v;
}

/**
 * Resolves a player's effective tendencies after applying their coaching
 * directives as additive deltas on the 0..100 scale. Only the user's HOME
 * team is coached; away players and neutral coaching return base tendencies
 * unchanged. Adds no rng.
 */
export function effectiveTendencies(p: Player): Tendencies {
  const base = tendenciesOf(p);
  if (p.team !== "home") return base;

  const c = playerCoaching(p.num);
  const t: Tendencies = { ...base };

  const freedomDelta = c.shotFreedom === "free" ? 20 : c.shotFreedom === "limited" ? -20 : 0;
  t.shootThree += freedomDelta;
  t.shootMid += freedomDelta;
  t.driveRim += freedomDelta;

  if (c.shotBias === "three") {
    t.shootThree += 20;
    t.driveRim -= 15;
  } else if (c.shotBias === "rim") {
    t.driveRim += 20;
    t.shootThree -= 15;
  }

  if (c.playmaking === "facilitate") t.pass += 25;
  else if (c.playmaking === "score") t.pass -= 25;

  if (c.reboundRole === "crash") t.crashGlass += 30;
  else if (c.reboundRole === "getback") t.crashGlass -= 30;

  if (c.aggression === "gamble") t.gambleSteal += 30;
  else if (c.aggression === "safe") t.gambleSteal -= 30;

  if (c.help === "help") t.helpDefense += 25;
  else if (c.help === "stayhome") t.helpDefense -= 25;

  t.shootThree = clamp01_100(t.shootThree);
  t.shootMid = clamp01_100(t.shootMid);
  t.driveRim = clamp01_100(t.driveRim);
  t.pass = clamp01_100(t.pass);
  t.crashGlass = clamp01_100(t.crashGlass);
  t.gambleSteal = clamp01_100(t.gambleSteal);
  t.helpDefense = clamp01_100(t.helpDefense);

  return t;
}
