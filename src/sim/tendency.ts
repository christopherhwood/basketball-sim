import type { Player, Tendencies } from "../types.js";

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
