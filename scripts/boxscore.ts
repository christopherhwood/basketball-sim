/* One-off: sim N games between two teams and print average per-player box scores.
   Usage: tsx scripts/boxscore.ts <homeId> <awayId> [games] */
import { newGame, G } from "../src/core/state.js";
import { seedRng } from "../src/core/rng.js";
import { tick } from "../src/sim/possession.js";
import { loadLeagueFromDir } from "../src/data/loadFromFs.js";
import { teamToEnginePlayers } from "../src/data/playerData.js";
import { getTally, getFastBreakOrigins, getDecisions, getTouches } from "../src/sim/debugTally.js";
import type { Player } from "../src/types.js";

const [homeId, awayId, gamesArg] = process.argv.slice(2);
const games = Number(gamesArg) || 20;
const { teams } = loadLeagueFromDir();
const homeTeam = teams.find((t) => t.id === homeId)!;
const awayTeam = teams.find((t) => t.id === awayId)!;

type Acc = { name: string; g: number; pts: number; fga: number; fgm: number; tpa: number; tpm: number; fta: number; ftm: number; reb: number; ast: number; stl: number; tov: number };
const accs = new Map<string, Acc>();
function add(players: Player[]) {
  for (const p of players) {
    let a = accs.get(p.name);
    if (!a) { a = { name: p.name, g: 0, pts: 0, fga: 0, fgm: 0, tpa: 0, tpm: 0, fta: 0, ftm: 0, reb: 0, ast: 0, stl: 0, tov: 0 }; accs.set(p.name, a); }
    const s = p.stats;
    a.g++; a.pts += s.pts; a.fga += s.fga; a.fgm += s.fgm; a.tpa += s.tpa; a.tpm += s.tpm;
    a.fta += s.fta; a.ftm += s.ftm; a.reb += s.reb; a.ast += s.ast; a.stl += s.stl; a.tov += s.tov;
  }
}

let homePts = 0, awayPts = 0;
for (let i = 0; i < games; i++) {
  seedRng(1 + i);
  newGame(1 + i, { home: teamToEnginePlayers(homeTeam, "home"), away: teamToEnginePlayers(awayTeam, "away") });
  G.homeAttack = "R"; G.awayAttack = "L"; G.attackHoop = "R";
  let guard = 0;
  while (!G.over && guard < 200_000) { tick(); guard++; }
  add(G.home); add(G.away);
  homePts += G.score.home; awayPts += G.score.away;
}

function row(a: Acc): string {
  const g = a.g;
  const f = (x: number) => (x / g).toFixed(1);
  return `${a.name.padEnd(24)} ${f(a.pts).padStart(5)}  ${f(a.fgm)}-${f(a.fga)}  ${f(a.tpm)}-${f(a.tpa)}  ${f(a.ftm)}-${f(a.fta)}  ${f(a.reb).padStart(4)} ${f(a.ast).padStart(4)} ${f(a.stl).padStart(4)} ${f(a.tov).padStart(4)}`;
}
function printTeam(label: string, players: Player[]) {
  console.log(`\n=== ${label} ===`);
  console.log(`${"PLAYER".padEnd(24)} ${"PTS".padStart(5)}  FG       3P      FT       REB  AST  STL   TO`);
  const rows = players.map((p) => accs.get(p.name)!).sort((x, y) => y.pts - x.pts);
  for (const a of rows) console.log(row(a));
}
console.log(`Avg score over ${games} games: HOME ${(homePts / games).toFixed(1)} - ${(awayPts / games).toFixed(1)} AWAY`);
printTeam(homeTeam.name ?? homeId, teamToEnginePlayers(homeTeam, "home"));
printTeam(awayTeam.name ?? awayId, teamToEnginePlayers(awayTeam, "away"));

const tch = getTouches();
if (tch.size) {
  console.log(`\nTouches (decision-windows) & shots/touch per game:`);
  const rows = [...accs.values()].sort((a, b) => b.pts - a.pts);
  for (const a of rows) {
    const t = (tch.get(a.name) ?? 0) / games;
    const fga = a.fga / games;
    if (t < 0.5) continue;
    console.log(`  ${a.name.padEnd(24)} touches ${t.toFixed(1).padStart(5)}  FGA ${fga.toFixed(1).padStart(5)}  FGA/touch ${(fga / t).toFixed(2)}`);
  }
}

const d = getDecisions();
const dTot = d.shoot + d.drive + d.pass + d.post + d.hold || 1;
console.log(`\nHalf-court decisions/game: shoot ${(d.shoot / games).toFixed(0)} · drive ${(d.drive / games).toFixed(0)} · pass ${(d.pass / games).toFixed(0)} · post ${(d.post / games).toFixed(1)} · hold ${(d.hold / games).toFixed(0)}`);
console.log(`Drive outcomes/game: chosen ${(d.drive / games).toFixed(0)} · beat-man ${(d.driveBeat / games).toFixed(1)} · contained(cutoff) ${(d.contained / games).toFixed(1)}`);

const { origins: fb, starts: ts } = getFastBreakOrigins();
const rate = (k: "steal" | "dreb") => (ts[k] ? `${((100 * fb[k]) / ts[k]).toFixed(0)}%` : "n/a");
console.log(`\nFast breaks/game: from steals ${(fb.steal / games).toFixed(1)} (of ${(ts.steal / games).toFixed(1)} = ${rate("steal")}) · from def-rebounds ${(fb.dreb / games).toFixed(1)} (of ${(ts.dreb / games).toFixed(1)} = ${rate("dreb")})`);

// Shot-source breakdown (per game). Where do the points actually come from?
const tally = getTally();
if (tally.size) {
  console.log(`\n=== SHOT SOURCE (per game: made-attempted) ===`);
  console.log(`${"PLAYER".padEnd(24)} ${"3PT".padStart(9)} ${"MID".padStart(9)} ${"HC-RIM".padStart(9)} ${"FB-RIM".padStart(9)} ${"CLOSE".padStart(9)}   PTS-from`);
  const names = [...accs.values()].sort((a, b) => b.pts - a.pts).map((a) => a.name);
  for (const name of names) {
    const r = tally.get(name);
    if (!r) continue;
    const c = (k: keyof typeof r) => `${(r[k].m / games).toFixed(1)}-${(r[k].a / games).toFixed(1)}`;
    const acc = accs.get(name)!;
    const ptsThree = (r.three.m * 3) / games;
    const ptsTwo = ((r.hcRim.m + r.fbRim.m + r.close.m + r.mid.m) * 2) / games;
    const ptsFt = acc.ftm / games;
    const src = `3:${ptsThree.toFixed(0)} 2:${ptsTwo.toFixed(0)} ft:${ptsFt.toFixed(0)}`;
    console.log(`${name.padEnd(24)} ${c("three").padStart(9)} ${c("mid").padStart(9)} ${c("hcRim").padStart(9)} ${c("fbRim").padStart(9)} ${c("close").padStart(9)}   ${src}`);
  }
}
