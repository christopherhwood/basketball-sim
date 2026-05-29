import { describe, expect, it } from "vitest";
import { HOOP } from "../src/core/constants.js";
import { newGame, G } from "../src/core/state.js";
import { offBallDefensiveTarget } from "../src/sim/defense.js";
import { beginLiveTransition, fastBreakRecoveryTarget, updateTransition } from "../src/sim/transition.js";

describe("defensive tracking and transition spacing", () => {
  it("low-IQ or low-rated off-ball defenders trail moving assignments more", () => {
    newGame(11);
    const runner = G.home[1];
    const defender = G.away[1];
    const hoop = HOOP.R;

    runner.x = 54;
    runner.y = 13;
    runner.vx = 14;
    runner.vy = 0;

    defender.attr.iq = 45;
    defender.attr.perimD = 45;
    defender.attr.interiorD = 45;
    const lowTarget = offBallDefensiveTarget(defender, runner, hoop);

    defender.attr.iq = 95;
    defender.attr.perimD = 95;
    defender.attr.interiorD = 95;
    const eliteTarget = offBallDefensiveTarget(defender, runner, hoop);

    expect(lowTarget.x).toBeLessThan(eliteTarget.x - 3);

    runner.vx = 0;
    const stillLowTarget = offBallDefensiveTarget(defender, runner, hoop);
    expect(stillLowTarget.x).toBeCloseTo(eliteTarget.x, 10);
  });

  it("wide speed edges decide whether fast-break defenders get goalside", () => {
    newGame(12);
    const runner = G.home[1];
    const defender = G.away[1];
    const hoop = HOOP.R;

    runner.x = 50;
    runner.y = 25;

    runner.attr.speed = 95;
    defender.attr.speed = 55;
    defender.attr.iq = 55;
    defender.attr.perimD = 55;
    defender.attr.interiorD = 55;
    const beatenTarget = fastBreakRecoveryTarget(defender, runner, hoop, false);
    expect(beatenTarget.x).toBeLessThan(runner.x);

    runner.attr.speed = 55;
    defender.attr.speed = 95;
    defender.attr.iq = 95;
    defender.attr.perimD = 95;
    defender.attr.interiorD = 95;
    const recoveredTarget = fastBreakRecoveryTarget(defender, runner, hoop, false);
    expect(recoveredTarget.x).toBeGreaterThan(runner.x + 10);
  });

  it("credited steals briefly delay the new defense reaction", () => {
    newGame(13);
    G.homeAttack = "L";
    G.awayAttack = "R";
    const stealer = G.away[0];
    beginLiveTransition(stealer, true);

    const oldTarget = { x: 12, y: 12 };
    G.home[0].target = oldTarget;
    G.trans!.phase = "advance";
    G.trans!.fastbreak = true;
    G.trans!.t = 0;
    G.trans!.pg.x = 50;
    G.trans!.pg.y = 25;

    updateTransition();

    expect(G.home[0].target).toEqual(oldTarget);
  });
});
