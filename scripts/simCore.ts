import { newGame, G } from "../src/core/state.js";
import { seedRng } from "../src/core/rng.js";
import { tick } from "../src/sim/possession.js";
import { loadLeagueFromDir } from "../src/data/loadFromFs.js";
import { teamToEnginePlayers } from "../src/data/playerData.js";
import { addTeamStats, blankAggregate, summarizeBatch, type BatchSummary, type TeamAggregate, type TeamMetrics } from "../src/sim/metrics.js";
import { setNeutralTacticsMode } from "../src/tactics/tactics.js";
import type { Player, TeamData } from "../src/types.js";

const TICK_GUARD = 200_000; // ~20k game-seconds; a full 48-min game is ~28.8k ticks of clock

export type SimBatchOptions = {
  games: number;
  seed: number;
  homeId?: string;
  awayId?: string;
  neutralTactics?: boolean;
  swap?: boolean;
};

export type SimBatchResult = {
  options: Required<Pick<SimBatchOptions, "games" | "seed" | "neutralTactics" | "swap">> & {
    homeId?: string;
    awayId?: string;
  };
  elapsedMs: number;
  runs: number;
  home: TeamAggregate;
  away: TeamAggregate;
  summary: BatchSummary;
};

function runGame(seed: number, rosters?: { home: Player[]; away: Player[] }): void {
  newGame(seed, rosters);
  G.homeAttack = "R";
  G.awayAttack = "L";
  G.attackHoop = "R";
  let guard = 0;
  while (!G.over && guard < TICK_GUARD) {
    tick();
    guard++;
  }
}

function loadTeams(homeId?: string, awayId?: string): { homeTeam?: TeamData; awayTeam?: TeamData } {
  if (!homeId && !awayId) return {};
  if (!homeId || !awayId) throw new Error("--home and --away must be supplied together");
  const { teams } = loadLeagueFromDir();
  const homeTeam = teams.find((t) => t.id === homeId);
  const awayTeam = teams.find((t) => t.id === awayId);
  if (!homeTeam) throw new Error(`--home team not found: ${homeId}`);
  if (!awayTeam) throw new Error(`--away team not found: ${awayId}`);
  return { homeTeam, awayTeam };
}

function makeRosters(homeTeam: TeamData | undefined, awayTeam: TeamData | undefined, swapped: boolean): { home: Player[]; away: Player[] } | undefined {
  if (!homeTeam || !awayTeam) return undefined;
  return swapped
    ? { home: teamToEnginePlayers(awayTeam, "home"), away: teamToEnginePlayers(homeTeam, "away") }
    : { home: teamToEnginePlayers(homeTeam, "home"), away: teamToEnginePlayers(awayTeam, "away") };
}

function recordResult(home: TeamAggregate, away: TeamAggregate): void {
  home.games++;
  away.games++;
  addTeamStats(home, G.home);
  addTeamStats(away, G.away);
  if (G.score.home > G.score.away) {
    home.wins++;
    away.losses++;
  } else if (G.score.away > G.score.home) {
    away.wins++;
    home.losses++;
  } else {
    home.ties++;
    away.ties++;
  }
}

export function runSimBatch(options: SimBatchOptions): SimBatchResult {
  const normalized = {
    games: options.games,
    seed: options.seed,
    homeId: options.homeId,
    awayId: options.awayId,
    neutralTactics: options.neutralTactics ?? false,
    swap: options.swap ?? false,
  };
  if (normalized.swap && (!normalized.homeId || !normalized.awayId)) {
    throw new Error("--swap requires fixed --home and --away rosters");
  }

  const { homeTeam, awayTeam } = loadTeams(normalized.homeId, normalized.awayId);
  const home = blankAggregate();
  const away = blankAggregate();
  const t0 = process.hrtime.bigint();
  setNeutralTacticsMode(normalized.neutralTactics);

  for (let i = 0; i < normalized.games; i++) {
    const seed = normalized.seed + i;
    seedRng(seed);
    runGame(seed, makeRosters(homeTeam, awayTeam, false));
    recordResult(home, away);

    if (normalized.swap) {
      seedRng(seed);
      runGame(seed, makeRosters(homeTeam, awayTeam, true));
      recordResult(home, away);
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    options: normalized,
    elapsedMs,
    runs: home.games,
    home,
    away,
    summary: summarizeBatch(home, away),
  };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function per(v: number, digits = 1): string {
  return v.toFixed(digits);
}

function report(label: string, m: TeamMetrics): string[] {
  return [
    label.padEnd(10) +
      `PTS ${per(m.pointsPerGame).padStart(5)}  ` +
      `POSS ${per(m.possessions).padStart(5)}  ` +
      `PPP ${per(m.ppp, 3).padStart(5)}  ` +
      `FG ${pct(m.fgPct).padStart(6)}  ` +
      `eFG ${pct(m.efgPct).padStart(6)}  ` +
      `3PAr ${pct(m.threeAttemptRate).padStart(6)}  ` +
      `FTr ${per(m.ftRate, 3).padStart(5)}`,
    "".padEnd(10) +
      `REB ${per(m.rebPerGame)}  ORB% ${pct(m.orbRate)}  AST/FGM ${pct(m.astRate)}  ` +
      `STL ${per(m.stlPerGame)}  TOV ${per(m.tovPerGame)}  TOV% ${pct(m.tovPct)}  BLK ${per(m.blkPerGame)}`,
  ];
}

export function formatHumanReport(result: SimBatchResult): string {
  const lines: string[] = [];
  const endSeed = result.options.seed + result.options.games - 1;
  lines.push("");
  lines.push(`SIDELINE headless sim — ${result.runs} runs (${result.options.games} seed${result.options.games === 1 ? "" : "s"} ${result.options.seed}..${endSeed})`);
  lines.push(`ran in ${result.elapsedMs.toFixed(0)}ms  (${(result.elapsedMs / result.runs).toFixed(1)}ms/run)`);
  lines.push(`mode: tactics=${result.options.neutralTactics ? "neutral" : "game"}${result.options.swap ? " · swapped home/away" : ""}`);
  lines.push("");
  lines.push(`record: HOME ${result.home.wins} wins · AWAY ${result.away.wins} wins${result.home.ties ? ` · ${result.home.ties} ties` : ""}`);
  lines.push(`side bias: HOME net ${result.summary.sideNetPtsPerGame.toFixed(1)} pts/run · win-pct delta ${(result.summary.sideWinPctDelta * 100).toFixed(1)} pp`);
  lines.push("");
  lines.push(...report("HOME", result.summary.home));
  lines.push("");
  lines.push(...report("AWAY", result.summary.away));
  lines.push("");
  return lines.join("\n");
}
