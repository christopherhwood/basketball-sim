/*
 * Headless multi-game stat harness.
 *
 * Runs full games to completion with no rendering and reports aggregate box-score
 * numbers — a fast sanity check on the simulation whenever the logic changes.
 *
 *   npm run sim                  # 100 games, base seed 1
 *   npm run sim -- --games 500   # more games for tighter averages
 *   npm run sim -- --seed 42     # different base seed
 *   npm run sim -- --home harbor-city-wolves --away summit-valley-rampart  # fixed rosters by team id
 *
 * Games are seeded base+i, so a given (games, seed) pair is fully reproducible.
 * When --home/--away are supplied the rosters come from fixed JSON data (not the
 * archetype generator), so a seeded loaded game is fully deterministic.
 */

import { newGame, G } from "../src/core/state.js";
import { seedRng } from "../src/core/rng.js";
import { tick } from "../src/sim/possession.js";
import { loadLeagueFromDir } from "../src/data/loadFromFs.js";
import { teamToEnginePlayers } from "../src/data/playerData.js";
import type { Player, Stats, TeamData } from "../src/types.js";

const TICK_GUARD = 200_000; // ~20k game-seconds; a full 48-min game is ~28.8k ticks of clock

interface Agg extends Stats {
  games: number;
  wins: number;
}

function blank(): Agg {
  return {
    games: 0, wins: 0,
    pts: 0, fga: 0, fgm: 0, tpa: 0, tpm: 0, reb: 0,
    ast: 0, stl: 0, blk: 0, tov: 0, fta: 0, ftm: 0,
  };
}

function addTeam(agg: Agg, team: Player[]): void {
  for (const p of team) {
    const s = p.stats;
    agg.pts += s.pts; agg.fga += s.fga; agg.fgm += s.fgm;
    agg.tpa += s.tpa; agg.tpm += s.tpm; agg.reb += s.reb;
    agg.ast += s.ast; agg.stl += s.stl; agg.blk += s.blk;
    agg.tov += s.tov; agg.fta += s.fta; agg.ftm += s.ftm;
  }
}

/* Mirror of main.ts newGameWrap, then tick to the final buzzer. */
function runGame(seed: number, rosters?: { home: Player[]; away: Player[] }): void {
  newGame(seed, rosters);
  G.homeAttack = "R";
  G.awayAttack = "L";
  G.attackHoop = "R";
  let guard = 0;
  while (!G.over && guard < TICK_GUARD) { tick(); guard++; }
}

function pct(made: number, att: number): string {
  return att > 0 ? ((made / att) * 100).toFixed(1) + "%" : "—";
}
function per(total: number, games: number, digits = 1): string {
  return (total / games).toFixed(digits);
}

function report(label: string, a: Agg): string[] {
  const g = a.games;
  // Possession estimate (standard approximation) for pace + efficiency.
  const poss = a.fga + a.tov + 0.44 * a.fta;
  const ppp = poss > 0 ? (a.pts / poss).toFixed(3) : "—";
  return [
    label.padEnd(10) +
      `PTS ${per(a.pts, g).padStart(5)}  ` +
      `FG ${per(a.fgm, g)}/${per(a.fga, g)} ${pct(a.fgm, a.fga).padStart(6)}  ` +
      `3P ${per(a.tpm, g)}/${per(a.tpa, g)} ${pct(a.tpm, a.tpa).padStart(6)}  ` +
      `FT ${per(a.ftm, g)}/${per(a.fta, g)} ${pct(a.ftm, a.fta).padStart(6)}`,
    "".padEnd(10) +
      `REB ${per(a.reb, g)}  AST ${per(a.ast, g)}  STL ${per(a.stl, g)}  ` +
      `TOV ${per(a.tov, g)}  BLK ${per(a.blk, g)}  ` +
      `POSS ${per(poss, g)}  PPP ${ppp}`,
  ];
}

function main(): void {
  const args = process.argv.slice(2);
  const num = (flag: string, def: number): number => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
  };
  const str = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
  };
  const games = num("--games", 100);
  const baseSeed = num("--seed", 1);
  const homeId = str("--home");
  const awayId = str("--away");

  let homeTeam: TeamData | undefined;
  let awayTeam: TeamData | undefined;
  if (homeId && awayId) {
    const { teams } = loadLeagueFromDir();
    homeTeam = teams.find((t) => t.id === homeId);
    awayTeam = teams.find((t) => t.id === awayId);
    if (!homeTeam) throw new Error(`--home team not found: ${homeId}`);
    if (!awayTeam) throw new Error(`--away team not found: ${awayId}`);
  }
  // Fresh engine players per game so stats/positions never carry over.
  const makeRosters = (): { home: Player[]; away: Player[] } | undefined =>
    homeTeam && awayTeam
      ? { home: teamToEnginePlayers(homeTeam, "home"), away: teamToEnginePlayers(awayTeam, "away") }
      : undefined;

  const home = blank();
  const away = blank();

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < games; i++) {
    const seed = baseSeed + i;
    seedRng(seed);
    runGame(seed, makeRosters());
    home.games++; away.games++;
    addTeam(home, G.home);
    addTeam(away, G.away);
    if (G.score.home > G.score.away) home.wins++;
    else if (G.score.away > G.score.home) away.wins++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const lines: string[] = [];
  lines.push("");
  lines.push(`SIDELINE headless sim — ${games} games (seeds ${baseSeed}..${baseSeed + games - 1})`);
  lines.push(`ran in ${ms.toFixed(0)}ms  (${(ms / games).toFixed(1)}ms/game)`);
  lines.push("");
  const ties = games - home.wins - away.wins;
  lines.push(`record: HOME ${home.wins} wins · AWAY ${away.wins} wins${ties ? ` · ${ties} ties` : ""} (per-game averages below)`);
  lines.push("");
  lines.push(...report("HOME", home));
  lines.push("");
  lines.push(...report("AWAY", away));
  lines.push("");

  console.log(lines.join("\n"));
}

main();
