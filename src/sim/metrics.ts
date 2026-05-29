import type { Player, Stats } from "../types.js";

export type TeamAggregate = Stats & {
  games: number;
  wins: number;
  losses: number;
  ties: number;
};

export type TeamMetrics = {
  pointsPerGame: number;
  possessions: number;
  ppp: number;
  fgPct: number;
  efgPct: number;
  threeAttemptRate: number;
  threePct: number;
  ftRate: number;
  ftPct: number;
  tovPct: number;
  astRate: number;
  orbRate: number;
  drbRate: number;
  rimAttemptRate: number;
  stlPerGame: number;
  blkPerGame: number;
  rebPerGame: number;
  tovPerGame: number;
  winPct: number;
};

export type BatchSummary = {
  games: number;
  home: TeamMetrics;
  away: TeamMetrics;
  sideNetPtsPerGame: number;
  sideWinPctDelta: number;
};

export function blankAggregate(): TeamAggregate {
  return {
    games: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    pts: 0,
    fga: 0,
    fgm: 0,
    tpa: 0,
    tpm: 0,
    rimFga: 0,
    reb: 0,
    oreb: 0,
    dreb: 0,
    ast: 0,
    stl: 0,
    blk: 0,
    tov: 0,
    fta: 0,
    ftm: 0,
  };
}

export function addTeamStats(agg: TeamAggregate, team: Player[]): void {
  for (const p of team) addStats(agg, p.stats);
}

export function addStats(agg: TeamAggregate, stats: Stats): void {
  agg.pts += stats.pts;
  agg.fga += stats.fga;
  agg.fgm += stats.fgm;
  agg.tpa += stats.tpa;
  agg.tpm += stats.tpm;
  agg.rimFga += stats.rimFga;
  agg.reb += stats.reb;
  agg.oreb += stats.oreb;
  agg.dreb += stats.dreb;
  agg.ast += stats.ast;
  agg.stl += stats.stl;
  agg.blk += stats.blk;
  agg.tov += stats.tov;
  agg.fta += stats.fta;
  agg.ftm += stats.ftm;
}

export function estimatedPossessions(a: Pick<Stats, "fga" | "tov" | "fta" | "oreb">): number {
  return Math.max(0, a.fga + a.tov + 0.44 * a.fta - a.oreb);
}

function safeDiv(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

export function summarizeTeam(a: TeamAggregate, opponent: TeamAggregate): TeamMetrics {
  const games = Math.max(1, a.games);
  const poss = estimatedPossessions(a);
  return {
    pointsPerGame: a.pts / games,
    possessions: poss / games,
    ppp: safeDiv(a.pts, poss),
    fgPct: safeDiv(a.fgm, a.fga),
    efgPct: safeDiv(a.fgm + 0.5 * a.tpm, a.fga),
    threeAttemptRate: safeDiv(a.tpa, a.fga),
    threePct: safeDiv(a.tpm, a.tpa),
    ftRate: safeDiv(a.fta, a.fga),
    ftPct: safeDiv(a.ftm, a.fta),
    tovPct: safeDiv(a.tov, poss),
    astRate: safeDiv(a.ast, a.fgm),
    orbRate: safeDiv(a.oreb, a.oreb + opponent.dreb),
    drbRate: safeDiv(a.dreb, a.dreb + opponent.oreb),
    rimAttemptRate: safeDiv(a.rimFga, a.fga),
    stlPerGame: a.stl / games,
    blkPerGame: a.blk / games,
    rebPerGame: a.reb / games,
    tovPerGame: a.tov / games,
    winPct: safeDiv(a.wins + a.ties * 0.5, a.games),
  };
}

export function summarizeBatch(home: TeamAggregate, away: TeamAggregate): BatchSummary {
  const games = Math.max(home.games, away.games);
  const h = summarizeTeam(home, away);
  const a = summarizeTeam(away, home);
  return {
    games,
    home: h,
    away: a,
    sideNetPtsPerGame: h.pointsPerGame - a.pointsPerGame,
    sideWinPctDelta: h.winPct - a.winPct,
  };
}
