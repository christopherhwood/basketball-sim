import type { Pos } from "../types.js";

export type ArchetypeTemplate = {
  speed: number;
  handle: number;
  pass: number;
  three: number;
  mid: number;
  finishing: number;
  perimD: number;
  steal: number;
  iq: number;
  strength: number;
  vertical: number;
  rebound: number;
  interiorD: number;
  block: number;
  height: number;
  tendShoot: number;
};

export type Archetype = { pos: Pos; t: ArchetypeTemplate };

export const ARCH: Record<string, Archetype> = {
  floor_gen: { pos: "PG", t: { speed: 88, handle: 90, pass: 92, three: 78, mid: 80, finishing: 78, perimD: 74, steal: 80, iq: 90, strength: 60, vertical: 70, rebound: 45, interiorD: 55, block: 35, height: 6.2, tendShoot: 0.55 } },
  sharp: { pos: "SG", t: { speed: 80, handle: 75, pass: 68, three: 92, mid: 84, finishing: 74, perimD: 72, steal: 70, iq: 78, strength: 62, vertical: 74, rebound: 48, interiorD: 55, block: 40, height: 6.4, tendShoot: 0.78 } },
  wing_3d: { pos: "SF", t: { speed: 82, handle: 72, pass: 66, three: 80, mid: 72, finishing: 80, perimD: 90, steal: 82, iq: 80, strength: 74, vertical: 82, rebound: 62, interiorD: 70, block: 58, height: 6.6, tendShoot: 0.5 } },
  stretch_4: { pos: "PF", t: { speed: 70, handle: 62, pass: 64, three: 82, mid: 78, finishing: 82, perimD: 66, steal: 60, iq: 76, strength: 80, vertical: 78, rebound: 78, interiorD: 78, block: 66, height: 6.9, tendShoot: 0.55 } },
  rim_big: { pos: "C", t: { speed: 58, handle: 48, pass: 56, three: 40, mid: 55, finishing: 90, perimD: 55, steal: 50, iq: 74, strength: 92, vertical: 80, rebound: 92, interiorD: 92, block: 90, height: 7.0, tendShoot: 0.45 } },
  slasher: { pos: "SG", t: { speed: 90, handle: 85, pass: 74, three: 64, mid: 72, finishing: 88, perimD: 76, steal: 78, iq: 78, strength: 70, vertical: 88, rebound: 52, interiorD: 60, block: 48, height: 6.5, tendShoot: 0.68 } },
};
