import { describe, it, expect, afterEach } from "vitest";
import { scoreCalibration, type CalibrationProfile } from "../src/sim/calibration.js";
import { blankAggregate, summarizeBatch } from "../src/sim/metrics.js";
import { resetSimTunables, setFlatTunables, simTunables } from "../src/sim/tunables.js";
import { isNeutralTacticsMode, setNeutralTacticsMode, tacFor } from "../src/tactics/tactics.js";

afterEach(() => {
  resetSimTunables();
  setNeutralTacticsMode(false);
});

describe("calibration metrics", () => {
  it("computes possession, efficiency, shot mix, and rebound rates from aggregates", () => {
    const home = blankAggregate();
    const away = blankAggregate();
    home.games = 1;
    home.wins = 1;
    home.pts = 120;
    home.fga = 100;
    home.fgm = 45;
    home.tpa = 40;
    home.tpm = 15;
    home.rimFga = 35;
    home.fta = 20;
    home.ftm = 15;
    home.tov = 10;
    home.reb = 50;
    home.oreb = 10;
    home.dreb = 40;
    home.ast = 25;
    home.stl = 8;
    home.blk = 5;

    away.games = 1;
    away.losses = 1;
    away.dreb = 35;
    away.oreb = 8;

    const summary = summarizeBatch(home, away);

    expect(summary.home.possessions).toBeCloseTo(108.8, 5);
    expect(summary.home.ppp).toBeCloseTo(120 / 108.8, 5);
    expect(summary.home.efgPct).toBeCloseTo(0.525, 5);
    expect(summary.home.threeAttemptRate).toBeCloseTo(0.4, 5);
    expect(summary.home.ftRate).toBeCloseTo(0.2, 5);
    expect(summary.home.orbRate).toBeCloseTo(10 / 45, 5);
    expect(summary.home.drbRate).toBeCloseTo(40 / 48, 5);
  });
});

describe("calibration loss", () => {
  it("penalizes only metrics outside the configured target range", () => {
    const home = blankAggregate();
    const away = blankAggregate();
    home.games = away.games = 1;
    home.pts = 120;
    away.pts = 110;
    home.fga = away.fga = 100;
    home.fgm = away.fgm = 45;
    const summary = summarizeBatch(home, away);
    const profile: CalibrationProfile = {
      name: "test",
      version: 1,
      metrics: {
        pointsPerGame: { min: 100, max: 130, weight: 1 },
        sideNetPtsPerGame: { min: -3, max: 3, weight: 2 },
      },
    };

    const score = scoreCalibration(summary, profile);

    expect(score.terms.find((t) => t.metric === "pointsPerGame")?.loss).toBe(0);
    expect(score.terms.find((t) => t.metric === "sideNetPtsPerGame")?.loss).toBeGreaterThan(0);
    expect(score.loss).toBeGreaterThan(0);
  });
});

describe("calibration controls", () => {
  it("can force both sides to use the neutral tactics profile", () => {
    expect(tacFor("home").pnr).toBe("drop");
    expect(tacFor("away").pnr).toBe("switch");

    setNeutralTacticsMode(true);

    expect(isNeutralTacticsMode()).toBe(true);
    expect(tacFor("home")).toEqual(tacFor("away"));
    expect(tacFor("home").pnr).toBe("drop");
  });

  it("clamps flat tunable overrides to their declared bounds", () => {
    setFlatTunables({
      "shooting.skillScale": 99,
      "turnovers.onBallScale": -99,
    });

    expect(simTunables().shooting.skillScale).toBe(1.35);
    expect(simTunables().turnovers.onBallScale).toBe(0.5);
  });
});
