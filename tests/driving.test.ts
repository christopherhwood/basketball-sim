/*
 * tests/driving.test.ts
 *
 * BEHAVIORAL TESTS — the offense drives to the rim.
 *
 * These tests confirm that the drive mechanic (src/sim/offense.ts) is active and
 * responds correctly to tendencies and player attributes:
 *
 *   1. FLOOR: a neutral team takes a meaningful share of rim+close field-goal
 *      attempts (rimFga / fga) — drives are happening, not just jumpers.
 *
 *   2. TENDENCY: driveRim=high produces clearly more rim+close attempts than
 *      driveRim forced to the floor, where drives are suppressed.
 *
 *   3. MATCHUP: a quick guard with a handle edge over the on-ball defender
 *      (speed/handle > defender speed/perimD) gets to the rim more than an
 *      identically-set-up slow handler in the same matchup.
 *
 *   4. POST: a physically-dominant big with high postUp tendency records more
 *      rim+close attempts (post-up branch fires) than the same big with low
 *      postUp tendency.
 *
 * All tests use fixed seeds and full-game loops; the margins are calibrated to
 * stay well above noise so the suite is stable without being brittle.
 */

import { describe, it, expect } from "vitest";
import { newGame, G } from "../src/core/state.js";
import { breathe } from "./helpers.js";
import { tick } from "../src/sim/possession.js";
import { toEnginePlayer } from "../src/data/playerData.js";
import type { Player, PlayerData, Tendencies, BaseAttributes, TeamSide, Pos } from "../src/types.js";

/* ---------- shared helpers (mirror of tendencies.test.ts style) ---------- */

const POSITIONS: Pos[] = ["PG", "SG", "SF", "PF", "C"];

function baseAttributes(over: Partial<BaseAttributes> = {}): BaseAttributes {
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
    drawFoul: 62,
    discipline: 70,
    ...over,
  };
}

function neutralTendencies(over: Partial<Tendencies> = {}): Tendencies {
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
    ...over,
  };
}

function makeRoster(
  side: TeamSide,
  attr: Partial<BaseAttributes> = {},
  tend: Partial<Tendencies> = {},
): Player[] {
  return POSITIONS.map((pos, i) => {
    const pd: PlayerData = {
      name: `${side[0].toUpperCase()}${pos}`,
      number: i + 1,
      position: pos,
      height: 6.5,
      attributes: baseAttributes(attr),
      tendencies: neutralTendencies(tend),
    };
    return toEnginePlayer(pd, side);
  });
}

const TICK_CAP = 7000;

function playGame(seed: number, home: Player[], away: Player[]): { home: Player[]; away: Player[] } {
  newGame(seed, { home, away });
  G.homeAttack = "R";
  G.awayAttack = "L";
  G.attackHoop = "R";
  for (let i = 0; i < TICK_CAP && !G.over; i++) tick();
  return { home: G.home, away: G.away };
}

const sum = (team: Player[], key: keyof Player["stats"]): number =>
  team.reduce((acc, p) => acc + p.stats[key], 0);

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

/* ---------- tests ---------- */

describe("driving behavior — rim+close attempts respond to tendencies and matchups", () => {
  /*
   * FLOOR: a high-driveRim team generates a meaningful share of its FGA as rim+close
   * attempts (observed ~0.19) AND clearly more than a drive-suppressed team. The floor
   * is intentionally below the observed rate to leave headroom against seed noise. It
   * was higher when the engine auto-set a ball screen EVERY possession; ball screens are
   * now SELECTIVE (the handler calls one only when contained — a player decision), so a
   * high-drive team gets to the rim more on its own raw drives than off automatic picks,
   * and the absolute rim share settled lower. The relative check below (≥1.8× the
   * suppressed baseline) is the real guard that drives respond to tendency.
   */
  it("rim+close FGA make up a meaningful share of attempts and clearly exceed a drive-suppressed baseline", async () => {
    let highRimFga = 0, highFga = 0;
    let lowRimFga = 0, lowFga = 0;
    for (const seed of SEEDS) {
      await breathe();
      const high = playGame(seed, makeRoster("home", {}, { driveRim: 80 }), makeRoster("away"));
      highRimFga += sum(high.home, "rimFga");
      highFga += sum(high.home, "fga");

      const low = playGame(seed, makeRoster("home", {}, { driveRim: 5 }), makeRoster("away"));
      lowRimFga += sum(low.home, "rimFga");
      lowFga += sum(low.home, "fga");
    }

    // floor: a meaningful share of shots are rim+close when driveRim is elevated
    // (observed ~0.19; floor kept below that for seed-noise headroom)
    expect(highRimFga / highFga).toBeGreaterThanOrEqual(0.16);

    // the high-drive team generates at least 1.8× the rim+close FGA of the
    // drive-suppressed team; observed ratio is ~2.6×
    expect(highRimFga).toBeGreaterThan(lowRimFga * 1.8);
  });

  /*
   * MATCHUP: a quick handler (speed=95, handle=90) attacking a slow, weak
   * perimeter defender (speed=60, perimD=60) drives more than a slow handler
   * (speed=50, handle=50) in the exact same matchup. We compare only the PG
   * (index 0) who is the primary ball-handler.
   *
   * Observed: quick=242 rimFga, slow=53 rimFga over 20 seeds.
   * Margin: quick > slow * 2.5 (well below the 4.5× observed).
   */
  it("a quick guard with a handle edge drives more than a slow handler vs the same defense", async () => {
    let quickRimFga = 0;
    let slowRimFga = 0;
    const awayAttr = { speed: 60, perimD: 60 };
    for (const seed of SEEDS) {
      await breathe();
      const quick = playGame(
        seed,
        makeRoster("home", { speed: 95, handleLeft: 90, handleRight: 90 }),
        makeRoster("away", awayAttr),
      );
      quickRimFga += quick.home[0].stats.rimFga;

      const slow = playGame(
        seed,
        makeRoster("home", { speed: 50, handleLeft: 50, handleRight: 50 }),
        makeRoster("away", awayAttr),
      );
      slowRimFga += slow.home[0].stats.rimFga;
    }

    expect(quickRimFga).toBeGreaterThan(slowRimFga * 2.5);
  });

  /*
   * POST: a physically dominant big (strength=90, weight=280) with high postUp
   * tendency (95) accumulates more rim+close attempts than the same big with
   * postUp=10, because the post-up branch fires and produces close shots.
   *
   * Observed: highPost=51 rimFga, lowPost=43 rimFga over 12 seeds (~1.19×).
   * Margin: high > low * 1.1 (leaves headroom above noise while confirming direction).
   */
  it("a high-postUp big records more rim+close attempts than a low-postUp big", async () => {
    let highRimFga = 0;
    let lowRimFga = 0;
    for (const seed of SEEDS) {
      await breathe();
      const high = playGame(
        seed,
        makeRoster("home", { strength: 90, weight: 280 }, { postUp: 95 }),
        makeRoster("away"),
      );
      highRimFga += sum(high.home, "rimFga");

      const low = playGame(
        seed,
        makeRoster("home", { strength: 90, weight: 280 }, { postUp: 10 }),
        makeRoster("away"),
      );
      lowRimFga += sum(low.home, "rimFga");
    }

    expect(highRimFga).toBeGreaterThan(lowRimFga * 1.1);
  });
});
