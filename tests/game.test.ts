/*
 * tests/game.test.ts
 *
 * WHOLE-ENGINE INVARIANTS + GOLDEN SIMULATION DIGEST.
 *
 * This is the key cross-language acceptance test. A port of this engine to
 * another language must reproduce the GOLDEN DIGEST numbers exactly. The RNG
 * (mulberry32-style, see src/core/rng.ts) is portable and deterministic, so a
 * faithful re-implementation that consumes the random stream in the same order
 * and runs the same number of ticks will land on the identical final score and
 * total field-goal attempts.
 *
 * ---- HOW TO MIRROR THE SETUP IN A PORT (mirror of main.ts newGameWrap) ----
 *   seedRng(7);          // seed the global mulberry32 state
 *   newGame(7);          // builds rosters + initial possession (re-seeds to 7)
 *   G.homeAttack = "R";  // home attacks the RIGHT hoop first
 *   G.awayAttack = "L";  // away attacks the LEFT hoop first
 *   G.attackHoop = "R";  // current possession attacks R (home has the ball)
 *   for (k ticks) tick();
 *
 * NOTE: newGame(seed) internally calls seedRng(seed) before generating the
 * rosters, so the explicit seedRng(7) above is redundant but documents intent
 * and mirrors what main.ts effectively relies on. The roster generation
 * consumes the RNG stream first; the simulation continues consuming from there.
 * A port MUST generate rosters with the exact same RNG draw order to align.
 *
 * The homeAttack/awayAttack fields matter: transition.ts and resolution.ts
 * read them when possession flips. If they are left undefined the engine
 * throws on the first made basket / turnover, so they MUST be set before ticking.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { seedRng } from "../src/core/rng.js";
import { newGame, G, players } from "../src/core/state.js";
import { tick } from "../src/sim/possession.js";
import type { Player } from "../src/types.js";

/* ----------------------------------------------------------------------------
 * TICK-LOOP HELPER (keep at the top so a porter can mirror it directly).
 * Sets up a seeded game exactly like main.ts's newGameWrap, then advances the
 * simulation by `ticks` calls to tick(). DT = 0.1s game-time per tick, so
 * 6000 ticks == 600s == one full 48-minute game can not be reached in real
 * minutes here but is plenty to exercise many possessions/quarters.
 * -------------------------------------------------------------------------- */
function setupSeededGame(seed: number): void {
  seedRng(seed);
  newGame(seed);
  G.homeAttack = "R";
  G.awayAttack = "L";
  G.attackHoop = "R";
}

function runTicks(n: number): void {
  for (let i = 0; i < n; i++) tick();
}

/* Sum of a single team's per-player points (used to cross-check the scoreboard). */
function sumPts(team: Player[]): number {
  return team.reduce((acc, p) => acc + p.stats.pts, 0);
}

describe("whole-engine invariants over a long seeded game", () => {
  /*
   * Invariant battery. We sample the engine at many checkpoints across a long
   * run and assert structural truths that must hold for ANY correct port:
   *   - scoreboard == sum of player points (no points appear out of nowhere)
   *   - shot clock is bounded [0,24] (with a 1-tick <=0 grace before violation)
   *   - game clock is monotonic non-increasing within a quarter
   *   - shooting tallies are internally consistent (makes<=attempts; 3s<=FGA)
   *   - quarter stays in [1,4]
   */
  beforeEach(() => {
    setupSeededGame(7);
  });

  it("scoreboard equals the sum of each team's players' points at every checkpoint", () => {
    // G.score[team] is incremented in lockstep with player.stats.pts (FG in
    // resolution.resolveShot / beginFouled, FT in updateFreeThrows). They must
    // never diverge.
    for (let c = 0; c < 60; c++) {
      runTicks(100); // sample every 100 ticks, 6000 total
      expect(G.score.home).toBe(sumPts(G.home));
      expect(G.score.away).toBe(sumPts(G.away));
    }
  });

  it("shot clock stays within [0,24] across the whole run", () => {
    // shotClock decrements by DT each live tick and resets to 24 (or 14 on an
    // offensive rebound) on possession changes. It may touch <=0 for exactly
    // the tick that triggers a shot-clock violation, before the reset.
    for (let i = 0; i < 6000; i++) {
      tick();
      // allow a tiny floating-point/violation grace below zero
      expect(G.shotClock).toBeLessThanOrEqual(24 + 1e-9);
      expect(G.shotClock).toBeGreaterThanOrEqual(-DT_GRACE);
    }
  });

  it("game clock is monotonic non-increasing within a quarter", () => {
    // gameClock counts down by DT per live tick and resets to qLen (12*60) only
    // when the quarter rolls over. Within a single quarter it must never rise.
    let prevClock = G.gameClock;
    let prevQuarter = G.quarter;
    for (let i = 0; i < 6000; i++) {
      tick();
      if (G.over) break;
      if (G.quarter === prevQuarter) {
        expect(G.gameClock).toBeLessThanOrEqual(prevClock + 1e-9);
      }
      prevClock = G.gameClock;
      prevQuarter = G.quarter;
    }
  });

  it("per-player shooting tallies are internally consistent", () => {
    // For every player at every checkpoint:
    //   fgm <= fga, tpm <= tpa, ftm <= fta, tpa <= fga
    // (a three is always also a field-goal attempt).
    for (let c = 0; c < 30; c++) {
      runTicks(200); // 6000 total
      for (const p of players()) {
        const s = p.stats;
        expect(s.fgm).toBeLessThanOrEqual(s.fga);
        expect(s.tpm).toBeLessThanOrEqual(s.tpa);
        expect(s.ftm).toBeLessThanOrEqual(s.fta);
        expect(s.tpa).toBeLessThanOrEqual(s.fga);
      }
    }
  });

  it("quarter stays in [1,4] throughout", () => {
    for (let i = 0; i < 6000; i++) {
      tick();
      expect(G.quarter).toBeGreaterThanOrEqual(1);
      expect(G.quarter).toBeLessThanOrEqual(4);
    }
  });
});

describe("possession sanity invariants", () => {
  // offense is always a real team; attackHoop is always a real hoop side.
  it("offense is 'home' or 'away' and attackHoop is 'L' or 'R' at all times", () => {
    setupSeededGame(7);
    for (let i = 0; i < 6000; i++) {
      tick();
      expect(G.offense === "home" || G.offense === "away").toBe(true);
      expect(G.attackHoop === "L" || G.attackHoop === "R").toBe(true);
    }
  });
});

describe("GOLDEN SIMULATION DIGEST (cross-language acceptance)", () => {
  /*
   * GOLDEN VECTOR. Seed 7, the standard newGameWrap setup, exactly 3000 ticks.
   * These EXACT numbers are the contract a port must reproduce. They were
   * discovered by running this engine and baking the deterministic output in.
   *
   * A port reproducing the mulberry32 stream and this tick count MUST match:
   *   - final home score
   *   - final away score
   *   - total field-goal attempts (fga) summed across all 10 players
   *
   * If a port diverges here, its RNG draw order or game logic differs.
   */
  it("seed 7, 3000 ticks: exact final score and total FGA", () => {
    setupSeededGame(7);
    runTicks(3000);

    const totalFga = players().reduce((a, p) => a + p.stats.fga, 0);

    // GOLDEN VALUES (baked from a verified run):
    expect(G.score.home).toBe(GOLDEN.homeScore);
    expect(G.score.away).toBe(GOLDEN.awayScore);
    expect(totalFga).toBe(GOLDEN.totalFga);

    // self-consistency at the golden checkpoint
    expect(G.score.home).toBe(sumPts(G.home));
    expect(G.score.away).toBe(sumPts(G.away));
  });
});

// DT grace: shotClock decrements by DT (0.1) and the violation is detected on
// the tick it reaches <=0, so it can dip to about -0 .. -DT before resetting.
const DT_GRACE = 0.1 + 1e-9;

// GOLDEN values — discovered from a verified deterministic run (seed 7, 3000 ticks).
// A port reproducing the mulberry32 stream and tick logic MUST match these exactly.
const GOLDEN = {
  homeScore: 8,
  awayScore: 11,
  totalFga: 20,
};
