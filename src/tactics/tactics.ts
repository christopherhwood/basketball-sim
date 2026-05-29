import type { TeamSide, Tactics } from "../types.js";

/* ---------- TACTICS (your team) ---------- */
export const tactics: Tactics = { defScheme: "man", pnr: "drop", pressure: "normal", pace: "bal", shotSel: "bal", action: "pnr" };
// opponent uses fixed, sane defaults so you can read your own changes
const cpuTac: Tactics = { defScheme: "man", pnr: "switch", pressure: "normal", pace: "bal", shotSel: "bal", action: "pnr" };
export const neutralTac: Tactics = { defScheme: "man", pnr: "drop", pressure: "normal", pace: "bal", shotSel: "bal", action: "pnr" };

let neutralTacticsMode = false;

export function setNeutralTacticsMode(enabled: boolean): void {
  neutralTacticsMode = enabled;
}

export function isNeutralTacticsMode(): boolean {
  return neutralTacticsMode;
}

export const tacFor = (t: TeamSide): Tactics => (neutralTacticsMode ? neutralTac : t === "home" ? tactics : cpuTac);
