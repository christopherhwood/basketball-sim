/* Diagnostic-only shot tally. Side-channel, no RNG, no effect on simulation
   output — gated by SIM_TALLY so it stays dormant unless a diagnostic asks for
   it. Records each field-goal attempt by shot type and transition vs half-court
   so we can see where a player's points actually come from. */
import type { ShotType } from "../types.js";

export type ShotKind = "fbRim" | "hcRim" | "close" | "mid" | "three";

type Row = Record<ShotKind, { a: number; m: number }>;

const ENABLED = typeof process !== "undefined" && process.env?.SIM_TALLY === "1";
const tally = new Map<string, Row>();

function blank(): Row {
  return { fbRim: { a: 0, m: 0 }, hcRim: { a: 0, m: 0 }, close: { a: 0, m: 0 }, mid: { a: 0, m: 0 }, three: { a: 0, m: 0 } };
}

export function recordShot(name: string, type: ShotType, made: boolean, transition: boolean): void {
  if (!ENABLED) return;
  let r = tally.get(name);
  if (!r) { r = blank(); tally.set(name, r); }
  const kind: ShotKind =
    type === "three" ? "three" : type === "mid" ? "mid" : type === "close" ? "close" : transition ? "fbRim" : "hcRim";
  r[kind].a++;
  if (made) r[kind].m++;
}

export function getTally(): Map<string, Row> {
  return tally;
}

const origins = { steal: 0, dreb: 0, other: 0 };
const starts = { steal: 0, dreb: 0, other: 0 };
export function recordFastBreak(kind: "steal" | "dreb" | "other"): void {
  if (!ENABLED) return;
  origins[kind]++;
}
export function recordTransitionStart(kind: "steal" | "dreb" | "other"): void {
  if (!ENABLED) return;
  starts[kind]++;
}
export function getFastBreakOrigins(): { origins: typeof origins; starts: typeof starts } {
  return { origins, starts };
}

const decisions = { shoot: 0, drive: 0, pass: 0, post: 0, hold: 0, contained: 0, driveBeat: 0 };
export function recordDecision(kind: keyof typeof decisions): void {
  if (!ENABLED) return;
  decisions[kind]++;
}
export function getDecisions(): typeof decisions {
  return decisions;
}

const tos = { strip: 0, cutoff: 0, badpass: 0, lane: 0 };
export function recordTO(kind: keyof typeof tos): void {
  if (!ENABLED) return;
  tos[kind]++;
}
export function getTOs(): typeof tos {
  return tos;
}

const touches = new Map<string, number>();
export function recordTouch(name: string): void {
  if (!ENABLED) return;
  touches.set(name, (touches.get(name) ?? 0) + 1);
}
export function getTouches(): Map<string, number> {
  return touches;
}
