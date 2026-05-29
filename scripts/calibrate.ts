/*
 * Deterministic offline calibration search.
 *
 *   npm run calibrate -- --games 20 --iterations 40
 *   npm run calibrate -- --home harbor-city-wolves --away summit-valley-rampart --swap
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSimBatch } from "./simCore.js";
import { scoreCalibration, type CalibrationProfile, type CalibrationScore } from "../src/sim/calibration.js";
import {
  flatDefaultTunables,
  resetSimTunables,
  setFlatTunables,
  TUNABLE_SPECS,
  type TunableKey,
} from "../src/sim/tunables.js";

type Candidate = {
  params: Partial<Record<TunableKey, number>>;
  score: CalibrationScore;
  summary: ReturnType<typeof runSimBatch>["summary"];
};

function has(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function num(args: string[], flag: string, def: number): number {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
}

function str(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

function loadProfile(path: string): CalibrationProfile {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as CalibrationProfile;
}

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function selectedKeys(raw: string | undefined): TunableKey[] {
  if (!raw || raw === "all") return TUNABLE_SPECS.map((s) => s.key);
  const requested = raw.split(",").map((x) => x.trim()).filter(Boolean);
  const known = new Set(TUNABLE_SPECS.map((s) => s.key));
  for (const key of requested) {
    if (!known.has(key as TunableKey)) throw new Error(`unknown tunable: ${key}`);
  }
  return requested as TunableKey[];
}

function randomCandidate(keys: TunableKey[], rng: () => number): Partial<Record<TunableKey, number>> {
  const out = flatDefaultTunables();
  for (const key of keys) {
    const spec = TUNABLE_SPECS.find((s) => s.key === key);
    if (!spec) continue;
    out[key] = spec.min + rng() * (spec.max - spec.min);
  }
  return out;
}

function evaluate(
  params: Partial<Record<TunableKey, number>>,
  profile: CalibrationProfile,
  options: {
    games: number;
    seed: number;
    homeId?: string;
    awayId?: string;
    swap: boolean;
  },
): Candidate {
  setFlatTunables(params);
  const result = runSimBatch({
    games: options.games,
    seed: options.seed,
    homeId: options.homeId,
    awayId: options.awayId,
    neutralTactics: true,
    swap: options.swap,
  });
  return {
    params: { ...params },
    score: scoreCalibration(result.summary, profile),
    summary: result.summary,
  };
}

function refine(
  best: Candidate,
  keys: TunableKey[],
  profile: CalibrationProfile,
  options: {
    games: number;
    seed: number;
    homeId?: string;
    awayId?: string;
    swap: boolean;
  },
): Candidate {
  let current = best;
  for (const key of keys) {
    const spec = TUNABLE_SPECS.find((s) => s.key === key);
    if (!spec) continue;
    const base = current.params[key] ?? spec.default;
    const step = (spec.max - spec.min) * 0.08;
    for (const delta of [-step, step]) {
      const params = { ...current.params, [key]: base + delta };
      const candidate = evaluate(params, profile, options);
      if (candidate.score.loss < current.score.loss) current = candidate;
    }
  }
  return current;
}

function main(): void {
  const args = process.argv.slice(2);
  const profile = loadProfile(str(args, "--profile") ?? "data/calibration/nba-like.json");
  const games = num(args, "--games", 20);
  const seed = num(args, "--seed", 1);
  const iterations = num(args, "--iterations", 30);
  const homeId = str(args, "--home");
  const awayId = str(args, "--away");
  const swap = has(args, "--swap") || (!!homeId && !!awayId);
  const keys = selectedKeys(str(args, "--params"));
  const rng = makeRng(num(args, "--search-seed", 1234));

  resetSimTunables();
  let best = evaluate(flatDefaultTunables(), profile, { games, seed, homeId, awayId, swap });
  for (let i = 0; i < iterations; i++) {
    const candidate = evaluate(randomCandidate(keys, rng), profile, { games, seed, homeId, awayId, swap });
    if (candidate.score.loss < best.score.loss) best = candidate;
  }
  best = refine(best, keys, profile, { games, seed, homeId, awayId, swap });
  resetSimTunables();

  const output = {
    profile: profile.name,
    games,
    seed,
    iterations,
    paramsSearched: keys,
    bestLoss: best.score.loss,
    bestParams: best.params,
    topLossTerms: best.score.terms.slice(0, 8),
    summary: best.summary,
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
