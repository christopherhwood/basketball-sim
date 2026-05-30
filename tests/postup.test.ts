/*
 * tests/postup.test.ts
 *
 * STATISTICAL BEHAVIORAL TESTS — physical attributes drive post play & rebounds.
 *
 * The engine added physical post-up scoring (src/sim/offense.ts) and a
 * rebounding mass term (src/sim/resolution.ts). A ball-handler with the ball
 * near the basket can back down the on-ball defender: the post-up utility AND
 * the make-prob/foul-draw bumps scale with the handler's physical EDGE
 * (strength + mass + height) over the defender, multiplied by the postUp
 * tendency. Heavier players also hold rebounding position better.
 *
 * These tests build two synthetic HOME teams that differ ONLY physically and
 * assert the direction:
 *   - a strong + heavy + high-postUp team produces MORE post offense (more
 *     close-shot points and far more drawn free throws) than a weak, light,
 *     low-postUp team against the SAME weak away defense; and
 *   - a heavy team grabs MORE rebounds than a light one with the opponent held
 *     fixed and neutral.
 *
 * Mirrors the full-game-loop helper style from tests/tendencies.test.ts: every
 * game is fully seeded and ticked to completion, and aggregates are summed over
 * many seeds so the directional signal dominates single-game noise.
 */

import { describe, it, expect } from "vitest";
import { newGame, G } from "../src/core/state.js";
import { tick } from "../src/sim/possession.js";
import { toEnginePlayer } from "../src/data/playerData.js";
import type { Player, PlayerData, Tendencies, BaseAttributes, TeamSide, Pos } from "../src/types.js";
import { breathe } from "./helpers.js";

const POSITIONS: Pos[] = ["PG", "SG", "SF", "PF", "C"];

// Neutral baseline ratings; callers override only the physical attributes under
// test (strength / weight) so any outcome difference is attributable to physique.
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

// Build a 5-player engine roster. Every player on the team shares the same
// physical overrides and tendency overrides, so the team is internally uniform
// and differs from its opponent only by the supplied overrides.
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
      tendencies: { ...neutralTendencies(), ...tend },
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

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

describe("physical post play and rebounding drive box-score behavior", () => {
  /*
   * PHYSIQUE: strength + weight + postUp.  DIRECTION: a strong, heavy team that
   * loves to post up backs down weak defenders for close looks and draws fouls.
   * Against the SAME weak away defense, the strong/heavy/high-postUp home team
   * should score MORE points and draw MANY more free throws than a weak, light,
   * low-postUp home team. (The away defense is identical in both runs, so only
   * the home team's physique differs.)
   */
  it("strong + heavy + high-postUp team scores MORE and draws MORE free throws in the post", async () => {
    let strongPts = 0;
    let weakPts = 0;
    let strongFta = 0;
    let weakFta = 0;
    for (const seed of SEEDS) {
      await breathe();
      const strong = playGame(
        seed,
        makeRoster("home", { strength: 99, weight: 300 }, { postUp: 100 }),
        makeRoster("away", { strength: 30, weight: 160 }, { postUp: 0 }),
      );
      strongPts += sum(strong.home, "pts");
      strongFta += sum(strong.home, "fta");

      const weak = playGame(
        seed,
        makeRoster("home", { strength: 30, weight: 160 }, { postUp: 0 }),
        makeRoster("away", { strength: 30, weight: 160 }, { postUp: 0 }),
      );
      weakPts += sum(weak.home, "pts");
      weakFta += sum(weak.home, "fta");
    }
    // comfortable margins: the post team clearly out-scores the weak team and
    // gets to the line far more often (the post-up branch routes foul draws to FTs).
    expect(strongPts).toBeGreaterThan(weakPts * 1.5);
    expect(strongFta).toBeGreaterThan(weakFta * 3);
  });

  /*
   * PHYSIQUE: weight.  DIRECTION: heavier players hold rebounding position, so a
   * heavy home team grabs MORE total rebounds than a light one. The away team is
   * held fixed and neutral in both runs, so only the home team's mass varies.
   */
  it("a heavy team grabs MORE rebounds than a light one (opponent held fixed)", async () => {
    let heavyReb = 0;
    let lightReb = 0;
    for (const seed of SEEDS) {
      await breathe();
      heavyReb += sum(
        playGame(seed, makeRoster("home", { weight: 320 }), makeRoster("away")).home,
        "reb",
      );
      lightReb += sum(
        playGame(seed, makeRoster("home", { weight: 150 }), makeRoster("away")).home,
        "reb",
      );
    }
    // the rebounding mass term is bounded (it nudges boards without overpowering
    // skill/height/box-out), so the edge is modest but consistently positive.
    expect(heavyReb).toBeGreaterThan(lightReb);
  });
});
