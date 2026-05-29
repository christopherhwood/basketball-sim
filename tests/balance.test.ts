import { describe, it, expect } from "vitest";
import { seedRng } from "../src/core/rng.js";
import { newGame, G, players } from "../src/core/state.js";
import { tick } from "../src/sim/possession.js";

/*
 * BALANCE FLOOR GUARD.
 *
 * The PR 4a balance pass added on-ball + bad-pass turnovers/steals so the box
 * score is realistic (live turnovers ~11-16 and steals ~6-10 per team per game,
 * up from ~2-5). This test pins a FLOOR — not exact values — so a future change
 * that silently kills turnovers/steals (the prior failure mode) fails CI.
 * Deterministic via fixed seeds; margins are comfortably below realistic levels.
 */
const TICK_GUARD = 200_000;

function playToBuzzer(seed: number): void {
  newGame(seed);
  G.homeAttack = "R";
  G.awayAttack = "L";
  G.attackHoop = "R";
  let g = 0;
  while (!G.over && g < TICK_GUARD) {
    tick();
    g++;
  }
}

describe("balance floor: turnovers and steals stay realistic", () => {
  it("turnovers and steals average well above zero across seeded games", () => {
    const SEEDS = 12;
    let tov = 0,
      stl = 0;
    for (let s = 1; s <= SEEDS; s++) {
      seedRng(s);
      playToBuzzer(s);
      for (const p of players()) {
        tov += p.stats.tov;
        stl += p.stats.stl;
      }
    }
    // two teams per game -> per-team-per-game = total / (SEEDS * 2)
    const tovPerTeam = tov / (SEEDS * 2);
    const stlPerTeam = stl / (SEEDS * 2);
    // realistic basketball is ~13 TOV / ~8 STL; these floors catch a regression
    // back toward the old near-zero turnover behavior without being flaky.
    expect(tovPerTeam).toBeGreaterThan(8);
    expect(stlPerTeam).toBeGreaterThan(4);
  });
});
