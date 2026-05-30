/* Diagnostic-only shot tally. Side-channel, no RNG, no effect on simulation
   output — gated by SIM_TALLY so it stays dormant unless a diagnostic asks for
   it. Records each field-goal attempt by shot type and transition vs half-court
   so we can see where a player's points actually come from. */
import type { ShotType, Player } from "../types.js";

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

type TOKind = "strip" | "cutoff" | "badpass" | "lane" | "threesec";
type TOZone = "rim" | "post" | "mid" | "perim";
const tos: Record<TOKind, number> = { strip: 0, cutoff: 0, badpass: 0, lane: 0, threesec: 0 };
type TOEntry = { kind: TOKind; name: string; pos: string; handle: number; zone: TOZone; intent: string };
const toLog: TOEntry[] = [];

/* Records a turnover with context: which player committed it (the ball-handler
   for strip/cutoff, the passer for badpass/lane), his position + ball skill, and
   the court zone he was in (distance from the rim he's attacking). Lets us see
   exactly WHO is coughing it up, WHERE, and on what kind of play. */
export function recordTO(kind: TOKind, p?: Player, dh?: number, intent?: string): void {
  if (!ENABLED) return;
  tos[kind]++;
  if (!p) return;
  const handle = Math.max(p.attr.handleLeft, p.attr.handleRight);
  const d = dh ?? 99;
  const zone: TOZone = d < 4 ? "rim" : d < 12 ? "post" : d < 20 ? "mid" : "perim";
  toLog.push({ kind, name: p.name, pos: p.pos, handle, zone, intent: intent ?? "?" });
}
export function getTOs(): typeof tos {
  return tos;
}

/* Aggregated turnover report: totals by kind, by court zone, by kind×zone, and
   the top offenders (name/pos/handle → count). */
export function getTOReport() {
  const byPlayer = new Map<string, { count: number; pos: string; handle: number }>();
  const byZone: Record<TOZone, number> = { rim: 0, post: 0, mid: 0, perim: 0 };
  const byKindZone = new Map<string, number>();
  const threeSecByIntent = new Map<string, number>();
  for (const e of toLog) {
    const r = byPlayer.get(e.name) ?? { count: 0, pos: e.pos, handle: e.handle };
    r.count++;
    byPlayer.set(e.name, r);
    byZone[e.zone]++;
    const k = `${e.kind}:${e.zone}`;
    byKindZone.set(k, (byKindZone.get(k) ?? 0) + 1);
    if (e.kind === "threesec") threeSecByIntent.set(e.intent, (threeSecByIntent.get(e.intent) ?? 0) + 1);
  }
  return { tos, total: toLog.length, byZone, byKindZone, byPlayer, threeSecByIntent };
}

const touches = new Map<string, number>();
export function recordTouch(name: string): void {
  if (!ENABLED) return;
  touches.set(name, (touches.get(name) ?? 0) + 1);
}
export function getTouches(): Map<string, number> {
  return touches;
}
