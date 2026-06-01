/*
 * Headless multi-game stat harness.
 *
 *   npm run sim
 *   npm run sim -- --games 500 --json
 *   npm run sim -- --home harbor-city-wolves --away summit-valley-rampart --swap
 *   npm run sim -- --asymmetric-tactics   # your-coached-team vs default-CPU matchup
 *   npm run sim -- --tunables /tmp/candidate.json
 *
 * Tactics default to NEUTRAL (both sides identical) so the harness measures
 * ENGINE balance, not the coached-vs-CPU tactic gap. Pass --asymmetric-tactics
 * to restore the playable matchup (home = your gameplan, away = CPU defaults).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatHumanReport, runSimBatch } from "./simCore.js";
import { resetSimTunables, setFlatTunables, type TunableKey } from "../src/sim/tunables.js";

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

function loadTunables(path: string): Partial<Record<TunableKey, number>> {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as {
    bestParams?: Partial<Record<TunableKey, number>>;
    params?: Partial<Record<TunableKey, number>>;
  } & Partial<Record<TunableKey, number>>;
  return raw.bestParams ?? raw.params ?? raw;
}

const args = process.argv.slice(2);
resetSimTunables();
const tunablesPath = str(args, "--tunables");
if (tunablesPath) setFlatTunables(loadTunables(tunablesPath));

const result = runSimBatch({
  games: num(args, "--games", 100),
  seed: num(args, "--seed", 1),
  homeId: str(args, "--home"),
  awayId: str(args, "--away"),
  neutralTactics: !has(args, "--asymmetric-tactics"),
  swap: has(args, "--swap"),
});

if (has(args, "--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatHumanReport(result));
}
