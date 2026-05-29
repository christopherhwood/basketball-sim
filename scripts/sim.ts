/*
 * Headless multi-game stat harness.
 *
 *   npm run sim
 *   npm run sim -- --games 500 --json
 *   npm run sim -- --home harbor-city-wolves --away summit-valley-rampart --neutral-tactics --swap
 */

import { formatHumanReport, runSimBatch } from "./simCore.js";

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

const args = process.argv.slice(2);
const result = runSimBatch({
  games: num(args, "--games", 100),
  seed: num(args, "--seed", 1),
  homeId: str(args, "--home"),
  awayId: str(args, "--away"),
  neutralTactics: has(args, "--neutral-tactics"),
  swap: has(args, "--swap"),
});

if (has(args, "--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatHumanReport(result));
}
