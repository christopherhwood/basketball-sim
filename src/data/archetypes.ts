import type { Pos, Tendencies } from "../types.js";

export type ArchetypeTemplate = {
  speed: number;
  handleLeft: number;
  handleRight: number;
  pass: number;
  three: number;
  mid: number;
  finishing: number;
  perimD: number;
  steal: number;
  iq: number;
  strength: number;
  weight: number;
  vertical: number;
  rebound: number;
  interiorD: number;
  block: number;
  height: number;
  tendShoot: number;
};

export type Archetype = { pos: Pos; t: ArchetypeTemplate; tend: Tendencies };

// handle scheme: handleRight ≈ old handle (the strong hand for right-dominant
// archetypes), handleLeft = strong − offhand gap. Gaps are smaller for
// guards/slashers (better off-hand) and larger for bigs. wing_3d is left-dominant
// for variety (handleLeft is the strong value). weight is in pounds, scaled by
// position/archetype. genPlayer derives the weak hand and weight without extra rng.
export const ARCH: Record<string, Archetype> = {
  floor_gen: { pos: "PG", t: { speed: 88, handleLeft: 74, handleRight: 90, weight: 185, pass: 92, three: 78, mid: 80, finishing: 78, perimD: 74, steal: 80, iq: 90, strength: 60, vertical: 70, rebound: 45, interiorD: 55, block: 35, height: 6.2, tendShoot: 0.55 }, tend: { shootThree: 60, shootMid: 55, driveRim: 55, pass: 85, postUp: 20, screen: 35, helpDefense: 55, gambleSteal: 55, crashGlass: 25, pushTransition: 70 } },
  sharp: { pos: "SG", t: { speed: 80, handleLeft: 58, handleRight: 75, weight: 200, pass: 68, three: 92, mid: 84, finishing: 74, perimD: 72, steal: 70, iq: 78, strength: 62, vertical: 74, rebound: 48, interiorD: 55, block: 40, height: 6.4, tendShoot: 0.78 }, tend: { shootThree: 88, shootMid: 75, driveRim: 30, pass: 45, postUp: 20, screen: 35, helpDefense: 45, gambleSteal: 45, crashGlass: 25, pushTransition: 50 } },
  wing_3d: { pos: "SF", t: { speed: 82, handleLeft: 72, handleRight: 54, weight: 220, pass: 66, three: 80, mid: 72, finishing: 80, perimD: 90, steal: 82, iq: 80, strength: 74, vertical: 82, rebound: 62, interiorD: 70, block: 58, height: 6.6, tendShoot: 0.5 }, tend: { shootThree: 62, shootMid: 50, driveRim: 50, pass: 50, postUp: 40, screen: 45, helpDefense: 75, gambleSteal: 70, crashGlass: 50, pushTransition: 55 } },
  stretch_4: { pos: "PF", t: { speed: 70, handleLeft: 42, handleRight: 62, weight: 245, pass: 64, three: 82, mid: 78, finishing: 82, perimD: 66, steal: 60, iq: 76, strength: 80, vertical: 78, rebound: 78, interiorD: 78, block: 66, height: 6.9, tendShoot: 0.55 }, tend: { shootThree: 75, shootMid: 60, driveRim: 45, pass: 45, postUp: 45, screen: 60, helpDefense: 55, gambleSteal: 45, crashGlass: 60, pushTransition: 45 } },
  rim_big: { pos: "C", t: { speed: 58, handleLeft: 27, handleRight: 48, weight: 265, pass: 56, three: 40, mid: 55, finishing: 90, perimD: 55, steal: 50, iq: 74, strength: 92, vertical: 80, rebound: 92, interiorD: 92, block: 90, height: 7.0, tendShoot: 0.45 }, tend: { shootThree: 15, shootMid: 35, driveRim: 70, pass: 40, postUp: 75, screen: 80, helpDefense: 70, gambleSteal: 40, crashGlass: 80, pushTransition: 25 } },
  slasher: { pos: "SG", t: { speed: 90, handleLeft: 69, handleRight: 85, weight: 205, pass: 74, three: 64, mid: 72, finishing: 88, perimD: 76, steal: 78, iq: 78, strength: 70, vertical: 88, rebound: 52, interiorD: 60, block: 48, height: 6.5, tendShoot: 0.68 }, tend: { shootThree: 55, shootMid: 55, driveRim: 85, pass: 50, postUp: 30, screen: 35, helpDefense: 50, gambleSteal: 60, crashGlass: 40, pushTransition: 80 } },
};
