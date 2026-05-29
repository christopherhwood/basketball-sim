export type SimTunables = {
  shooting: {
    skillScale: number;
    contestScale: number;
  };
  fouls: {
    insideScale: number;
    perimeterScale: number;
  };
  turnovers: {
    onBallScale: number;
    badPassScale: number;
    laneStealScale: number;
  };
  rebounding: {
    defensiveBoxoutScale: number;
    crashGlassScale: number;
  };
  decisions: {
    threeUtilityScale: number;
    driveUtilityScale: number;
    passUtilityScale: number;
  };
};

export type TunableKey =
  | "shooting.skillScale"
  | "shooting.contestScale"
  | "fouls.insideScale"
  | "fouls.perimeterScale"
  | "turnovers.onBallScale"
  | "turnovers.badPassScale"
  | "turnovers.laneStealScale"
  | "rebounding.defensiveBoxoutScale"
  | "rebounding.crashGlassScale"
  | "decisions.threeUtilityScale"
  | "decisions.driveUtilityScale"
  | "decisions.passUtilityScale";

export type TunableSpec = {
  key: TunableKey;
  label: string;
  default: number;
  min: number;
  max: number;
  unit: string;
  primaryMetric: string;
};

export const DEFAULT_SIM_TUNABLES: SimTunables = {
  shooting: {
    skillScale: 1,
    contestScale: 1,
  },
  fouls: {
    insideScale: 1,
    perimeterScale: 1,
  },
  turnovers: {
    onBallScale: 1,
    badPassScale: 1,
    laneStealScale: 1,
  },
  rebounding: {
    defensiveBoxoutScale: 1,
    crashGlassScale: 1,
  },
  decisions: {
    threeUtilityScale: 1,
    driveUtilityScale: 1,
    passUtilityScale: 1,
  },
};

export const TUNABLE_SPECS: TunableSpec[] = [
  { key: "shooting.skillScale", label: "shooting skill influence", default: 1, min: 0.65, max: 1.35, unit: "multiplier", primaryMetric: "fgPct" },
  { key: "shooting.contestScale", label: "contest penalty", default: 1, min: 0.65, max: 1.45, unit: "multiplier", primaryMetric: "efgPct" },
  { key: "fouls.insideScale", label: "inside foul rate", default: 1, min: 0.65, max: 1.35, unit: "multiplier", primaryMetric: "ftRate" },
  { key: "fouls.perimeterScale", label: "perimeter foul rate", default: 1, min: 0.65, max: 1.35, unit: "multiplier", primaryMetric: "ftRate" },
  { key: "turnovers.onBallScale", label: "on-ball turnover rate", default: 1, min: 0.5, max: 1.6, unit: "multiplier", primaryMetric: "tovPct" },
  { key: "turnovers.badPassScale", label: "bad-pass turnover rate", default: 1, min: 0.5, max: 1.6, unit: "multiplier", primaryMetric: "tovPct" },
  { key: "turnovers.laneStealScale", label: "lane steal rate", default: 1, min: 0.5, max: 1.6, unit: "multiplier", primaryMetric: "stlPerGame" },
  { key: "rebounding.defensiveBoxoutScale", label: "defensive box-out edge", default: 1, min: 0.7, max: 1.35, unit: "multiplier", primaryMetric: "orbRate" },
  { key: "rebounding.crashGlassScale", label: "crash-glass tendency edge", default: 1, min: 0.6, max: 1.6, unit: "multiplier", primaryMetric: "orbRate" },
  { key: "decisions.threeUtilityScale", label: "three-point utility", default: 1, min: 0.7, max: 1.4, unit: "multiplier", primaryMetric: "threeAttemptRate" },
  { key: "decisions.driveUtilityScale", label: "drive utility", default: 1, min: 0.7, max: 1.4, unit: "multiplier", primaryMetric: "rimAttemptRate" },
  { key: "decisions.passUtilityScale", label: "pass utility", default: 1, min: 0.7, max: 1.4, unit: "multiplier", primaryMetric: "assistRate" },
];

let currentTunables: SimTunables = cloneTunables(DEFAULT_SIM_TUNABLES);

function cloneTunables(t: SimTunables): SimTunables {
  return {
    shooting: { ...t.shooting },
    fouls: { ...t.fouls },
    turnovers: { ...t.turnovers },
    rebounding: { ...t.rebounding },
    decisions: { ...t.decisions },
  };
}

export function simTunables(): SimTunables {
  return currentTunables;
}

export function resetSimTunables(): void {
  currentTunables = cloneTunables(DEFAULT_SIM_TUNABLES);
}

export function flatDefaultTunables(): Record<TunableKey, number> {
  return Object.fromEntries(TUNABLE_SPECS.map((s) => [s.key, s.default])) as Record<TunableKey, number>;
}

export function setFlatTunables(values: Partial<Record<TunableKey, number>>): void {
  const next = cloneTunables(DEFAULT_SIM_TUNABLES);
  for (const spec of TUNABLE_SPECS) {
    const value = values[spec.key];
    if (value === undefined) continue;
    const clamped = value < spec.min ? spec.min : value > spec.max ? spec.max : value;
    const [section, field] = spec.key.split(".") as [keyof SimTunables, string];
    (next[section] as Record<string, number>)[field] = clamped;
  }
  currentTunables = next;
}
