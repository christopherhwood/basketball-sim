import { ARC_R } from "./constants.js";
import { rng } from "./rng.js";
import type { Point, ShotType } from "../types.js";

export const rnd = (a: number, b: number): number => a + rng() * (b - a);
export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const chance = (p: number): boolean => rng() < p;
export function randn(): number {
  let u = 0,
    v = 0;
  while (!u) u = rng();
  while (!v) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
// distance from point P to segment AB (used for pass-lane steal checks)
export function distToSeg(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x,
    vy = b.y - a.y,
    wx = p.x - a.x,
    wy = p.y - a.y;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return dist(p, a);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return dist(p, b);
  const t = c1 / c2;
  return dist(p, { x: a.x + t * vx, y: a.y + t * vy });
}
export function shotTypeFor(d: number): ShotType {
  if (d <= 4) return "rim";
  if (d <= 8) return "close";
  if (d >= ARC_R - 0.5) return "three";
  return "mid";
}
