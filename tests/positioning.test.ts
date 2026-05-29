/*
 * tests/positioning.test.ts
 *
 * STATISTICAL BEHAVIORAL TEST — off-ball spacing puts bigs inside.
 *
 * The movement model (src/sim/offense.ts, offBallMove + isInsidePlayer) routes a
 * low-shootThree / high-postUp player to the INSIDE spots (blocks, short corner,
 * dunker) and spaces high-shootThree shooters to the perimeter. This test proves
 * that role split shows up in the players' on-court coordinates: a low-shootThree
 * "big" averages clearly CLOSER to the attacked hoop than a high-shootThree
 * shooter during settled half-court offense.
 *
 * Mirrors the full-game-loop helper style of tests/tendencies.test.ts: identical
 * synthetic rosters that differ only in one player's shootThree tendency, fixed
 * seeds, and a comfortable margin so the signal dominates the noise.
 *
 * DISTANCE METRIC: we measure distance to the attacked hoop along the attack
 * (x) axis. That axis captures "depth" toward the rim/baseline, which is exactly
 * what "bigs play inside" means; the cross-court (y) spread of the block spots
 * would otherwise muddy a raw Euclidean distance. We only sample SETTLED
 * half-court ticks (home has the ball, in the frontcourt, shot clock wound down)
 * so transition runs do not pollute the spacing signal.
 */

import { describe, it, expect } from "vitest";
import { newGame, G } from "../src/core/state.js";
import { tick } from "../src/sim/possession.js";
import { toEnginePlayer } from "../src/data/playerData.js";
import { HOOP } from "../src/core/constants.js";
import type { Player, PlayerData, Tendencies, BaseAttributes, TeamSide, Pos } from "../src/types.js";

const POSITIONS: Pos[] = ["PG", "SG", "SF", "PF", "C"];

// Indices into the 5-player roster for the two players we watch.
const SHOOTER_IDX = 1; // high-shootThree wing -> spaces to the perimeter
const BIG_IDX = 4; // low-shootThree center -> operates inside

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

// Build a 5-player roster. Identical neutral attributes for everyone; tendencies
// are produced by tend(i) so the only thing that varies is shootThree on two
// players, isolating the spacing behavior under test.
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

// home roster: index BIG_IDX is a low-shootThree big (inside role); index
// SHOOTER_IDX is a high-shootThree shooter (perimeter role). Everyone else neutral.
function homeTend(i: number): Partial<Tendencies> {
  if (i === BIG_IDX) return { shootThree: 5 };
  if (i === SHOOTER_IDX) return { shootThree: 95 };
  return {};
}

const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1);

describe("off-ball spacing positions bigs inside", () => {
  /*
   * DIRECTION: a low-shootThree big averages CLOSER to the attacked hoop than a
   * high-shootThree shooter during settled half-court offense. We accumulate each
   * player's distance to the hoop along the attack axis over many seeded games and
   * assert the big's average is comfortably smaller than the shooter's.
   */
  it("low-shootThree big averages closer to the hoop than a high-shootThree shooter", () => {
    let bigDistSum = 0;
    let shooterDistSum = 0;
    let samples = 0;

    for (const seed of SEEDS) {
      newGame(seed, { home: makeRoster("home", homeTend), away: makeRoster("away", () => ({})) });
      G.homeAttack = "R";
      G.awayAttack = "L";
      G.attackHoop = "R";
      const hoopX = HOOP.R.x; // home attacks the RIGHT hoop

      for (let i = 0; i < 3000 && !G.over; i++) {
        tick();
        // settled half-court offense only: home has the ball, the ball is in the
        // attacking frontcourt, and the shot clock has wound down past the early
        // transition window. This filters out fast breaks where everyone sprints.
        if (G.offense === "home" && G.ball.holder && G.ball.x > 47 && G.shotClock < 20) {
          bigDistSum += Math.abs(G.home[BIG_IDX].x - hoopX);
          shooterDistSum += Math.abs(G.home[SHOOTER_IDX].x - hoopX);
          samples++;
        }
      }
    }

    // sanity: we actually observed a meaningful number of half-court ticks
    expect(samples).toBeGreaterThan(500);

    const bigAvg = bigDistSum / samples;
    const shooterAvg = shooterDistSum / samples;

    // the big plays inside: comfortably closer to the hoop than the shooter.
    // observed separation is large (big ~11.5 ft, shooter ~20.5 ft along the axis),
    // so a 1.3x margin leaves plenty of headroom against per-game noise.
    expect(bigAvg).toBeLessThan(shooterAvg);
    expect(shooterAvg).toBeGreaterThan(bigAvg * 1.3);
  }, 30000);
});
