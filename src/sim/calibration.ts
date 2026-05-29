import type { BatchSummary, TeamMetrics } from "./metrics.js";

export type CalibrationMetricKey = keyof TeamMetrics | "sideNetPtsPerGame" | "sideWinPctDelta";

export type CalibrationTarget = {
  min: number;
  max: number;
  weight: number;
};

export type CalibrationProfile = {
  name: string;
  version: number;
  description?: string;
  metrics: Partial<Record<CalibrationMetricKey, CalibrationTarget>>;
};

export type CalibrationLossTerm = {
  metric: CalibrationMetricKey;
  value: number;
  min: number;
  max: number;
  weight: number;
  loss: number;
};

export type CalibrationScore = {
  loss: number;
  terms: CalibrationLossTerm[];
};

export function metricValue(summary: BatchSummary, key: CalibrationMetricKey): number {
  if (key === "sideNetPtsPerGame") return summary.sideNetPtsPerGame;
  if (key === "sideWinPctDelta") return summary.sideWinPctDelta;
  return (summary.home[key] + summary.away[key]) / 2;
}

export function scoreCalibration(summary: BatchSummary, profile: CalibrationProfile): CalibrationScore {
  const terms: CalibrationLossTerm[] = [];
  let loss = 0;
  for (const [rawKey, target] of Object.entries(profile.metrics)) {
    if (!target) continue;
    const key = rawKey as CalibrationMetricKey;
    const value = metricValue(summary, key);
    const width = Math.max(target.max - target.min, 1e-9);
    const miss = value < target.min ? target.min - value : value > target.max ? value - target.max : 0;
    const termLoss = target.weight * (miss / width) ** 2;
    loss += termLoss;
    terms.push({ metric: key, value, min: target.min, max: target.max, weight: target.weight, loss: termLoss });
  }
  terms.sort((a, b) => b.loss - a.loss);
  return { loss, terms };
}
