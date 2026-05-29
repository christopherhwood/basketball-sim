/* Shot-probability helpers shared by the offense AI and transition finishes.
   Kept in their own module so offense and transition need not import each other. */

import { dist, clamp } from "../core/math.js";
import { simTunables } from "./tunables.js";
import type { Player, ShotType } from "../types.js";

export function nearestDef(p: Player, def: Player[]): { d: Player | null; dd: number } {
  let best: Player | null = null,
    bd = 1e9;
  for (const d of def) {
    const dd = dist(p, d);
    if (dd < bd) {
      bd = dd;
      best = d;
    }
  }
  return { d: best, dd: bd };
}

export function makeProb(shooter: Player, type: ShotType, contest: number): number {
  const tuning = simTunables().shooting;
  const base = { rim: 0.68, close: 0.5, mid: 0.44, three: 0.372 }[type];
  const sk =
    type === "rim" || type === "close"
      ? shooter.attr.finishing
      : type === "mid"
        ? shooter.attr.mid
        : shooter.attr.three;
  let p = base + ((sk - 55) / 55) * 0.24 * tuning.skillScale; // shooting skill
  const cpen = (type === "rim" ? 0.15 : type === "three" ? 0.21 : 0.25) * tuning.contestScale;
  p -= contest * cpen; // defender contest
  p -= shooter.fatigue * 0.05;
  return clamp(p, 0.02, 0.97);
}

export function contestOf(shooter: Player, def: Player[]): number {
  const { d, dd } = nearestDef(shooter, def);
  const prox = clamp(1 - dd / 9, 0, 1); // no real contest past ~9 ft
  const skill = clamp((d ? d.attr.perimD : 50) / 95, 0, 1.05);
  return clamp(prox * skill, 0, 1);
}
