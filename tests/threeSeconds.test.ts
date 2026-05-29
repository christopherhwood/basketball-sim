import { afterEach, describe, expect, it } from "vitest";
import { HOOP } from "../src/core/constants.js";
import { rules } from "../src/core/rules.js";
import { G, newGame } from "../src/core/state.js";
import { toEnginePlayer } from "../src/data/playerData.js";
import { tick } from "../src/sim/possession.js";
import { enforceThreeSeconds } from "../src/sim/threeSeconds.js";
import type { BaseAttributes, Player, PlayerData, Pos, TeamSide, Tendencies } from "../src/types.js";

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

function highIqRoster(side: TeamSide): Player[] {
  const roster = makeRoster(side);
  roster.forEach((p) => (p.attr.iq = 99));
  return roster;
}

afterEach(() => {
  rules.offensiveThreeSeconds = true;
  rules.defensiveThreeSeconds = true;
  rules.threeSecondLimit = 3;
});

describe("three-second lane rules", () => {
  it("turns the ball over when an offensive player camps in the lane", () => {
    newGame(1, { home: makeRoster("home"), away: makeRoster("away") });
    G.homeAttack = "R";
    G.awayAttack = "L";
    G.attackHoop = "R";

    const camper = G.home[4];
    camper.x = HOOP.R.x - 4;
    camper.y = 25;
    camper.target = { x: camper.x, y: camper.y };

    let handled = false;
    for (let i = 0; i < 31 && !handled; i++) handled = enforceThreeSeconds();

    expect(handled).toBe(true);
    expect(camper.stats.tov).toBe(1);
    expect(G.offense).toBe("away");
    expect(G.feed[0].t).toContain("offensive three seconds");
  });

  it("lets aware offensive players clear the lane before a three-second call", () => {
    newGame(3, { home: highIqRoster("home"), away: makeRoster("away") });
    G.homeAttack = "R";
    G.awayAttack = "L";
    G.attackHoop = "R";

    const big = G.home[4];
    big.x = HOOP.R.x - 4;
    big.y = 25;
    big.target = { x: big.x, y: big.y };
    big.offLaneT = 1.8;

    for (let i = 0; i < 20 && G.offense === "home"; i++) tick();

    expect(G.offense).toBe("home");
    expect(big.stats.tov).toBe(0);
    expect(big.y).not.toBe(25);
  });

  it("awards a technical free throw when a defender camps in the lane unguarding", () => {
    newGame(2, { home: makeRoster("home"), away: makeRoster("away") });
    G.homeAttack = "R";
    G.awayAttack = "L";
    G.attackHoop = "R";

    const defender = G.away[4];
    defender.x = HOOP.R.x - 4;
    defender.y = 25;
    defender.target = { x: defender.x, y: defender.y };
    G.home.forEach((p) => {
      p.x = HOOP.R.x - 24;
      p.y = 5 + p.num * 7;
    });

    for (let i = 0; i < 31; i++) enforceThreeSeconds();

    expect(G.score.home).toBe(1);
    expect(G.offense).toBe("home");
    expect(G.home.some((p) => p.stats.fta === 1 && p.stats.ftm === 1)).toBe(true);
    expect(G.feed[0].t).toContain("defensive three seconds");
  });
});
