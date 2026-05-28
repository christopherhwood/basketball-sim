/*
 * tests/matchup.test.ts
 *
 * Tests src/app/matchup.ts buildRosters against the shipped league data
 * loaded through the node:fs loader (src/data/loadFromFs.ts).
 */

import { describe, it, expect } from "vitest";
import { loadLeagueFromDir } from "../src/data/loadFromFs.js";
import { buildRosters, GENERATED } from "../src/app/matchup.js";

const { teams } = loadLeagueFromDir("data");

describe("buildRosters", () => {
  it("loaded at least two real teams from the shipped data", () => {
    expect(teams.length).toBeGreaterThanOrEqual(2);
  });

  it("returns undefined when the home side is __generated__", () => {
    expect(buildRosters({ home: GENERATED, away: teams[0].id }, teams)).toBeUndefined();
  });

  it("returns undefined when the away side is __generated__", () => {
    expect(buildRosters({ home: teams[0].id, away: GENERATED }, teams)).toBeUndefined();
  });

  it("returns undefined when both sides are __generated__", () => {
    expect(buildRosters({ home: GENERATED, away: GENERATED }, teams)).toBeUndefined();
  });

  it("maps both real team ids to 5 engine players per side", () => {
    const rosters = buildRosters({ home: teams[0].id, away: teams[1].id }, teams);
    expect(rosters).toBeDefined();
    expect(rosters!.home).toHaveLength(5);
    expect(rosters!.away).toHaveLength(5);
    for (const p of [...rosters!.home, ...rosters!.away]) {
      expect(typeof p.name).toBe("string");
    }
  });

  it("throws on an unknown home id", () => {
    expect(() => buildRosters({ home: "no-such-team", away: teams[1].id }, teams)).toThrow(
      /team not found: no-such-team/,
    );
  });

  it("throws on an unknown away id", () => {
    expect(() => buildRosters({ home: teams[0].id, away: "no-such-team" }, teams)).toThrow(
      /team not found: no-such-team/,
    );
  });
});
