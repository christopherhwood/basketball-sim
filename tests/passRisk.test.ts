import { describe, expect, it } from "vitest";
import { HOOP } from "../src/core/constants.js";
import { passRouteRisk, passSelectionPenalty } from "../src/sim/offense.js";
import type { Player, Point } from "../src/types.js";

function playerAt(pt: Point, pass: number, iq: number): Player {
  return {
    team: "home",
    num: 1,
    pos: "PG",
    arch: "test",
    attr: {
      speed: 70,
      handleLeft: 70,
      handleRight: 70,
      pass,
      three: 70,
      mid: 70,
      finishing: 70,
      perimD: 70,
      steal: 70,
      iq,
      strength: 70,
      weight: 200,
      vertical: 70,
      rebound: 70,
      interiorD: 70,
      block: 70,
      drawFoul: 62,
      discipline: 70,
      height: 6.4,
      tendShoot: 0.5,
    },
    x: pt.x,
    y: pt.y,
    vx: 0,
    vy: 0,
    hasBall: true,
    fatigue: 0,
    target: null,
    role: "",
    assign: null,
    stats: { pts: 0, fga: 0, fgm: 0, tpa: 0, tpm: 0, rimFga: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fta: 0, ftm: 0 },
    name: "Passer",
  };
}

describe("pass route risk", () => {
  it("marks diagonal corner-to-paint entry passes as much riskier than short perimeter swings", () => {
    const h = HOOP.R;
    const safeSwing = passRouteRisk({ x: 69, y: 25 }, { x: 70, y: 34 }, h);
    const diagonalEntry = passRouteRisk({ x: 66, y: 46 }, { x: 82, y: 19 }, h);

    expect(safeSwing).toBeLessThan(0.1);
    expect(diagonalEntry).toBeGreaterThan(1.2);
  });

  it("makes higher-IQ handlers downgrade the same bad route more aggressively", () => {
    const h = HOOP.R;
    const target = { x: 82, y: 19 };
    const lowIq = passSelectionPenalty(playerAt({ x: 66, y: 46 }, 60, 45), target, h);
    const highIq = passSelectionPenalty(playerAt({ x: 66, y: 46 }, 60, 85), target, h);

    expect(highIq).toBeGreaterThan(lowIq * 1.8);
  });
});
