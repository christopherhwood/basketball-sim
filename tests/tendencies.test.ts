/*
 * tests/tendencies.test.ts
 *
 * STATISTICAL BEHAVIORAL TESTS — tendencies drive decisions.
 *
 * The engine recently changed so per-player TENDENCIES (0..100, 50 = neutral)
 * scale decision utilities and chances (see src/sim/tendency.ts and its callers
 * in offense.ts / defense.ts / resolution.ts / transition.ts). These tests prove
 * that changing ONE tendency moves the corresponding box-score aggregate in the
 * EXPECTED direction.
 *
 * Each test builds two synthetic teams that are IDENTICAL except for the single
 * tendency under test, runs many fully-seeded games to completion (newGame(seed,
 * {home, away}) + the standard homeAttack=R / awayAttack=L / attackHoop=R setup,
 * ticking until G.over), aggregates the relevant stat across all seeds, and
 * asserts the direction with a comfortable margin so the assertion is robust to
 * the inherent randomness of any single game.
 *
 * Determinism: every game is seeded, so the suite is reproducible. We use a large
 * gap in the tendency under test (e.g. 95 vs 10) and many seeds so the aggregate
 * signal dominates noise.
 */

import { describe, it, expect } from "vitest";
import { newGame, G } from "../src/core/state.js";
import { tick } from "../src/sim/possession.js";
import { toEnginePlayer } from "../src/data/playerData.js";
import type { Player, PlayerData, Tendencies, BaseAttributes, TeamSide, Pos } from "../src/types.js";

/* ---------------------------------------------------------------------------
 * Synthetic-team construction.
 * Every player is a clone with neutral-ish ratings; only tendencies vary per
 * test. Positions are laid out PG/SG/SF/PF/C so the engine's index-based
 * matchups line up cleanly (index 0 is the on-ball handler / PG).
 * ------------------------------------------------------------------------- */
const POSITIONS: Pos[] = ["PG", "SG", "SF", "PF", "C"];

function baseAttributes(): BaseAttributes {
  return {
    speed: 75,
    handleLeft: 75,
    handleRight: 75,
    weight: 220,
    pass: 75,
    three: 75,
    mid: 75,
    finishing: 75,
    perimD: 75,
    steal: 75,
    iq: 75,
    strength: 75,
    vertical: 75,
    rebound: 75,
    interiorD: 75,
    block: 75,
  };
}

function neutralTendencies(): Tendencies {
  return {
    shootThree: 50,
    shootMid: 50,
    driveRim: 50,
    pass: 50,
    postUp: 50,
    screen: 50,
    helpDefense: 50,
    gambleSteal: 50,
    crashGlass: 50,
    pushTransition: 50,
  };
}

// Build a 5-player engine roster whose tendencies are produced by `tend(i)`
// (index 0..4). Attribute ratings are identical for every player on every team,
// so any difference in outcomes is attributable solely to the tendencies.
function makeRoster(side: TeamSide, tend: (i: number) => Partial<Tendencies>): Player[] {
  return POSITIONS.map((pos, i) => {
    const pd: PlayerData = {
      name: `${side[0].toUpperCase()}${pos}`,
      number: i + 1,
      position: pos,
      height: 6.5,
      attributes: baseAttributes(),
      tendencies: { ...neutralTendencies(), ...tend(i) },
    };
    return toEnginePlayer(pd, side);
  });
}

// Run one full seeded game with the standard setup and return the finished G's
// home/away rosters so callers can read box-score stats.
function playGame(seed: number, home: Player[], away: Player[]): { home: Player[]; away: Player[] } {
  newGame(seed, { home, away });
  G.homeAttack = "R";
  G.awayAttack = "L";
  G.attackHoop = "R";
  // hard tick cap so a pathological game can never hang the suite
  for (let i = 0; i < 100000 && !G.over; i++) tick();
  return { home: G.home, away: G.away };
}

const sum = (team: Player[], key: keyof Player["stats"]): number =>
  team.reduce((acc, p) => acc + p.stats[key], 0);

// Count how many passes the watched team starts (transitions into ball.state
// "pass" while it is on offense). Assists only register on a made shot
// immediately after a pass, so the cleaner, less make-dependent signal that a
// team "passes more" is the raw pass count.
function playGameCountingPasses(
  seed: number,
  home: Player[],
  away: Player[],
  watch: TeamSide,
): number {
  newGame(seed, { home, away });
  G.homeAttack = "R";
  G.awayAttack = "L";
  G.attackHoop = "R";
  let passes = 0;
  for (let i = 0; i < 100000 && !G.over; i++) {
    const before = G.ball.state;
    tick();
    if (G.ball.state === "pass" && before !== "pass" && G.offense === watch) passes++;
  }
  return passes;
}

// Count offensive rebounds for the team-under-test by detecting, per tick, a
// `reb` increment on a player whose team currently HAS the ball (G.offense). A
// rebound credited to the offense is by definition an offensive rebound.
function playGameCountingOffReb(
  seed: number,
  home: Player[],
  away: Player[],
  watch: TeamSide,
): number {
  newGame(seed, { home, away });
  G.homeAttack = "R";
  G.awayAttack = "L";
  G.attackHoop = "R";
  const team = watch === "home" ? G.home : G.away;
  let prevReb = team.map((p) => p.stats.reb);
  let offReb = 0;
  for (let i = 0; i < 100000 && !G.over; i++) {
    tick();
    for (let j = 0; j < team.length; j++) {
      if (team[j].stats.reb > prevReb[j] && G.offense === watch) {
        offReb += team[j].stats.reb - prevReb[j];
      }
      prevReb[j] = team[j].stats.reb;
    }
  }
  return offReb;
}

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

describe("tendencies drive box-score behavior", () => {
  /*
   * TENDENCY: shootThree.  DIRECTION: higher shootThree => MORE 3PT attempts.
   * A team of high-shootThree shooters should attempt clearly more threes (sum
   * of tpa) than an otherwise identical team that almost never shoots threes.
   */
  it("high shootThree attempts MORE threes than low shootThree (sum tpa)", () => {
    let highTpa = 0;
    let lowTpa = 0;
    for (const seed of SEEDS) {
      // home = trigger-happy from deep; away = neutral control
      const high = playGame(
        seed,
        makeRoster("home", () => ({ shootThree: 95 })),
        makeRoster("away", () => ({})),
      );
      highTpa += sum(high.home, "tpa");
      // home = allergic to threes; away = neutral control
      const low = playGame(
        seed,
        makeRoster("home", () => ({ shootThree: 10 })),
        makeRoster("away", () => ({})),
      );
      lowTpa += sum(low.home, "tpa");
    }
    // generous margin: the high team should take meaningfully more threes
    expect(highTpa).toBeGreaterThan(lowTpa * 1.5);
  }, 30000);

  /*
   * TENDENCY: pass.  DIRECTION: higher pass => the team PASSES MORE.
   * A team that loves to pass should move the ball more often than an otherwise
   * identical low-pass team. We count passes started while on offense (an assist
   * only registers on the made shot right after a pass, so the raw pass count is
   * the cleaner, less make-dependent signal the spec calls for). The opponent is
   * held neutral so only the passing team's own behavior varies.
   */
  it("high pass tendency PASSES MORE than low pass (passes started on offense)", () => {
    let highPasses = 0;
    let lowPasses = 0;
    for (const seed of SEEDS) {
      highPasses += playGameCountingPasses(
        seed,
        makeRoster("home", () => ({ pass: 95 })),
        makeRoster("away", () => ({})),
        "home",
      );
      lowPasses += playGameCountingPasses(
        seed,
        makeRoster("home", () => ({ pass: 10 })),
        makeRoster("away", () => ({})),
        "home",
      );
    }
    expect(highPasses).toBeGreaterThan(lowPasses * 1.15);
  }, 30000);

  /*
   * TENDENCY: gambleSteal.  DIRECTION: higher gambleSteal => MORE steals.
   * The DEFENSE varies (home), the OFFENSE is held fixed (neutral away). A
   * gambling defense should generate more steals (sum stl) than a passive one
   * against the identical offense.
   */
  it("high gambleSteal defense records MORE steals than low gambleSteal (sum stl)", () => {
    let highStl = 0;
    let lowStl = 0;
    for (const seed of SEEDS) {
      // away offense is identical/neutral in both runs; only the home DEFENSE differs
      const high = playGame(
        seed,
        makeRoster("home", () => ({ gambleSteal: 95 })),
        makeRoster("away", () => ({})),
      );
      highStl += sum(high.home, "stl");
      const low = playGame(
        seed,
        makeRoster("home", () => ({ gambleSteal: 10 })),
        makeRoster("away", () => ({})),
      );
      lowStl += sum(low.home, "stl");
    }
    expect(highStl).toBeGreaterThan(lowStl * 1.3);
  }, 30000);

  /*
   * TENDENCY: crashGlass.  DIRECTION: higher crashGlass => MORE offensive boards.
   * The opponent (away) is held fixed/neutral; only the home team's crashGlass
   * varies. We count OFFENSIVE rebounds (a rebound credited while the team has
   * the ball) for the home team and expect the crashing team to grab more.
   */
  it("high crashGlass grabs MORE offensive rebounds than low crashGlass", () => {
    let highOreb = 0;
    let lowOreb = 0;
    for (const seed of SEEDS) {
      highOreb += playGameCountingOffReb(
        seed,
        makeRoster("home", () => ({ crashGlass: 100 })),
        makeRoster("away", () => ({})),
        "home",
      );
      lowOreb += playGameCountingOffReb(
        seed,
        makeRoster("home", () => ({ crashGlass: 0 })),
        makeRoster("away", () => ({})),
        "home",
      );
    }
    expect(highOreb).toBeGreaterThan(lowOreb * 1.08);
  }, 30000);
});
