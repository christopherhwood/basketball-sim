/*
 * tests/coaching.test.ts
 *
 * BEHAVIORAL SPECS FOR COACHING DIRECTIVES.
 *
 * Coaching directives (src/coaching/coaching.ts) are resolved into effective
 * tendencies for the HOME team only (see effectiveTendencies in
 * src/sim/tendency.ts). At the NEUTRAL setting the resolver is identity, so the
 * golden digests in game.test.ts / data.test.ts are unaffected.
 *
 * These tests prove that flipping a single directive on ALL home players moves
 * the corresponding HOME box-score aggregate in the EXPECTED direction relative
 * to a neutral-coaching baseline (or the opposite directive). We reuse the same
 * fully-seeded full-game-loop style as tendencies.test.ts: identical synthetic
 * rosters, fixed seeds, comfortable margins so the signal dominates noise.
 *
 * resetCoaching() runs in beforeEach so directives never leak between cases.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { newGame, G } from "../src/core/state.js";
import { tick } from "../src/sim/possession.js";
import { toEnginePlayer } from "../src/data/playerData.js";
import { resetCoaching, setPlayerCoaching, NEUTRAL_PLAYER_COACHING } from "../src/coaching/coaching.js";
import type {
  Player,
  PlayerData,
  Tendencies,
  BaseAttributes,
  TeamSide,
  Pos,
  PlayerCoaching,
} from "../src/types.js";
import { breathe } from "./helpers.js";

const POSITIONS: Pos[] = ["PG", "SG", "SF", "PF", "C"];

// Home players are numbered 1..5 (number = index + 1); coaching is keyed by num.
const HOME_NUMS = [1, 2, 3, 4, 5];

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
    drawFoul: 62,
    discipline: 70,
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

// Identical rosters for both teams; only coaching directives vary per test.
function makeRoster(side: TeamSide): Player[] {
  return POSITIONS.map((pos, i) => {
    const pd: PlayerData = {
      name: `${side[0].toUpperCase()}${pos}`,
      number: i + 1,
      position: pos,
      height: 6.5,
      attributes: baseAttributes(),
      tendencies: neutralTendencies(),
    };
    return toEnginePlayer(pd, side);
  });
}

// Apply one coaching directive to every home player.
function coachHome(c: PlayerCoaching): void {
  for (const num of HOME_NUMS) setPlayerCoaching(num, c);
}

function setup(seed: number): void {
  newGame(seed, { home: makeRoster("home"), away: makeRoster("away") });
  G.homeAttack = "R";
  G.awayAttack = "L";
  G.attackHoop = "R";
}

function playToBuzzer(): void {
  for (let i = 0; i < 100000 && !G.over; i++) tick();
}

const sum = (team: Player[], key: keyof Player["stats"]): number =>
  team.reduce((acc, p) => acc + p.stats[key], 0);

// Aggregate a HOME box-score stat across seeds for a given home coaching directive.
async function aggregateHome(seeds: number[], home: PlayerCoaching, key: keyof Player["stats"]): Promise<number> {
  let total = 0;
  for (const seed of seeds) {
    await breathe();
    resetCoaching();
    coachHome(home);
    setup(seed);
    playToBuzzer();
    total += sum(G.home, key);
  }
  return total;
}

// Aggregate the HOME three-point SHARE (3PA / FGA) across seeds for a directive.
// shotBias shifts the *mix* of shots toward/away from three more cleanly than it
// moves raw 3PA volume (pace shifts when the rim tendency drops), so the share is
// the robust signal that the team is leaning into threes.
async function aggregateHomeThreeShare(seeds: number[], home: PlayerCoaching): Promise<number> {
  let tpa = 0;
  let fga = 0;
  for (const seed of seeds) {
    await breathe();
    resetCoaching();
    coachHome(home);
    setup(seed);
    playToBuzzer();
    tpa += sum(G.home, "tpa");
    fga += sum(G.home, "fga");
  }
  return tpa / fga;
}

// Count passes the home team starts on offense across seeds for a directive.
async function aggregateHomePasses(seeds: number[], home: PlayerCoaching): Promise<number> {
  let passes = 0;
  for (const seed of seeds) {
    await breathe();
    resetCoaching();
    coachHome(home);
    setup(seed);
    for (let i = 0; i < 100000 && !G.over; i++) {
      const before = G.ball.state;
      tick();
      if (G.ball.state === "pass" && before !== "pass" && G.offense === "home") passes++;
    }
  }
  return passes;
}

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

const withDirective = (over: Partial<PlayerCoaching>): PlayerCoaching => ({
  ...NEUTRAL_PLAYER_COACHING,
  ...over,
});

describe("coaching directives drive home box-score behavior", () => {
  beforeEach(() => {
    resetCoaching();
  });

  /*
   * shotBias "three" => the home team attempts MORE threes than neutral. Measured
   * as the three-point share of all field-goal attempts (3PA / FGA), which isolates
   * the shift in shot MIX from the pace changes that raw 3PA volume conflates.
   */
  it('shotBias "three" attempts MORE threes than neutral (3PA share of FGA)', async () => {
    const threeShare = await aggregateHomeThreeShare(SEEDS, withDirective({ shotBias: "three" }));
    const neutralShare = await aggregateHomeThreeShare(SEEDS, NEUTRAL_PLAYER_COACHING);
    expect(threeShare).toBeGreaterThan(neutralShare * 1.005);
  });

  /*
   * shotFreedom "free" => the home team takes MORE field-goal attempts than "limited".
   */
  it('shotFreedom "free" takes MORE field-goal attempts than "limited" (sum fga)', async () => {
    const freeFga = await aggregateHome(SEEDS, withDirective({ shotFreedom: "free" }), "fga");
    const limitedFga = await aggregateHome(SEEDS, withDirective({ shotFreedom: "limited" }), "fga");
    expect(freeFga).toBeGreaterThan(limitedFga * 1.02);
  });

  /*
   * playmaking "facilitate" => the home team starts MORE passes than "score".
   */
  it('playmaking "facilitate" starts MORE passes than "score"', async () => {
    const facilitate = await aggregateHomePasses(SEEDS, withDirective({ playmaking: "facilitate" }));
    const score = await aggregateHomePasses(SEEDS, withDirective({ playmaking: "score" }));
    expect(facilitate).toBeGreaterThan(score * 1.06);
  });

  /*
   * aggression "gamble" => the home team records MORE steals than "safe".
   */
  it('aggression "gamble" records MORE steals than "safe" (sum stl)', async () => {
    const gamble = await aggregateHome(SEEDS, withDirective({ aggression: "gamble" }), "stl");
    const safe = await aggregateHome(SEEDS, withDirective({ aggression: "safe" }), "stl");
    expect(gamble).toBeGreaterThan(safe * 1.25);
  });
});
