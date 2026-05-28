import type { TeamSide, Tactics } from "../types.js";

/* ---------- TACTICS (your team) ---------- */
export const tactics: Tactics = { defScheme: "man", pnr: "drop", pressure: "normal", pace: "bal", shotSel: "bal", action: "pnr" };
// opponent uses fixed, sane defaults so you can read your own changes
export const cpuTac: Tactics = { defScheme: "man", pnr: "switch", pressure: "normal", pace: "bal", shotSel: "bal", action: "pnr" };
export const tacFor = (t: TeamSide): Tactics => (t === "home" ? tactics : cpuTac);
