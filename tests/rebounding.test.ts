import { describe, it, expect } from "vitest";
import { seedRng } from "../src/core/rng.js";
import { newGame, G, players } from "../src/core/state.js";
import { tick } from "../src/sim/possession.js";

/*
 * REBOUND DISTRIBUTION GUARD.
 *
 * The old model let the lone inside big hoard ~70% of boards while guards got
 * ~1-2%. The carom-landing + post-shot-convergence + soft proximity-weighted
 * draw spreads boards realistically (center ~30-40%, guards a real share). This
 * pins a FLOOR/CEILING so that regression can't silently return. Deterministic
 * via fixed seeds; margins are loose so it isn't flaky.
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

describe("rebounds spread realistically across positions", () => {
  it("the center does not hoard, and guards get a real share", () => {
    const byPos: Record<string, number> = { PG: 0, SG: 0, SF: 0, PF: 0, C: 0 };
    let total = 0;
    for (let s = 1; s <= 16; s++) {
      seedRng(s);
      playToBuzzer(s);
      for (const p of players()) {
        byPos[p.pos] += p.stats.reb;
        total += p.stats.reb;
      }
    }
    const share = (pos: string): number => byPos[pos] / total;
    // center used to be ~70%; should now be a realistic plurality, not a monopoly
    expect(share("C")).toBeLessThan(0.45);
    expect(share("C")).toBeGreaterThan(0.2); // still the leading rebounder
    // guards used to get ~1-2%; should now get a real combined share
    expect(share("PG") + share("SG")).toBeGreaterThan(0.08);
  });
});
