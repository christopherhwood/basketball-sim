/*
 * tests/data.test.ts
 *
 * PLAYER-DATA SYSTEM TESTS.
 *
 * Exercises the external-JSON player-data pipeline end to end:
 *   - loadLeagueFromDir("data") loads every shipped file without throwing
 *   - validateTeamData rejects malformed input (range / missing / enum)
 *   - toEnginePlayer maps PlayerData -> engine Player correctly
 *   - a seeded game built from the two loaded sample teams stays self-consistent
 *     and reproduces an exact golden final score
 *
 * Uses the node:fs loader (src/data/loadFromFs.ts) and the pure core
 * (src/data/playerData.ts), NOT the browser glob module.
 */

import { describe, it, expect } from "vitest";
import { loadLeagueFromDir } from "../src/data/loadFromFs.js";
import { validateTeamData, validateFreeAgentsData, toEnginePlayer } from "../src/data/playerData.js";
import { clamp } from "../src/core/math.js";
import { seedRng } from "../src/core/rng.js";
import { newGame, G } from "../src/core/state.js";
import { tick } from "../src/sim/possession.js";
import { teamToEnginePlayers } from "../src/data/playerData.js";
import type { Player, PlayerData, TeamData } from "../src/types.js";

const ATTR_KEYS = [
  "speed",
  "handleLeft",
  "handleRight",
  "pass",
  "three",
  "mid",
  "finishing",
  "perimD",
  "steal",
  "iq",
  "strength",
  "vertical",
  "rebound",
  "interiorD",
  "block",
  "drawFoul",
  "discipline",
] as const;

const TEND_KEYS = [
  "shootThree",
  "shootMid",
  "driveRim",
  "pass",
  "postUp",
  "screen",
  "helpDefense",
  "gambleSteal",
  "crashGlass",
  "pushTransition",
] as const;

function makeAttributes(): PlayerData["attributes"] {
  return {
    speed: 80,
    handleLeft: 80,
    handleRight: 80,
    weight: 220,
    pass: 80,
    three: 80,
    mid: 80,
    finishing: 80,
    perimD: 80,
    steal: 80,
    iq: 80,
    strength: 80,
    vertical: 80,
    rebound: 80,
    interiorD: 80,
    block: 80,
    drawFoul: 62,
    discipline: 70,
  };
}

function makeTendencies(): PlayerData["tendencies"] {
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

function makePlayer(overrides: Partial<PlayerData> = {}): PlayerData {
  return {
    name: "Test Player",
    number: 7,
    position: "PG",
    height: 6.2,
    attributes: makeAttributes(),
    tendencies: makeTendencies(),
    ...overrides,
  };
}

function makeTeam(player: PlayerData): TeamData {
  return {
    id: "test-team",
    name: "Test Team",
    abbrev: "TST",
    players: [player],
  };
}

describe("shipped data files load and validate", () => {
  it("loadLeagueFromDir('data') loads without throwing", () => {
    expect(() => loadLeagueFromDir("data")).not.toThrow();
  });

  it("found the sample teams and the free-agents pool", () => {
    const league = loadLeagueFromDir("data");
    const ids = league.teams.map((t) => t.id);
    expect(ids).toContain("harbor-city-wolves");
    expect(ids).toContain("summit-valley-rampart");
    expect(league.teams.length).toBeGreaterThanOrEqual(2);
    // free-agents pool exists (an array, populated in the shipped data)
    expect(Array.isArray(league.freeAgents)).toBe(true);
    expect(league.freeAgents.length).toBeGreaterThan(0);
  });

  it("each loaded team has at least 5 players", () => {
    const league = loadLeagueFromDir("data");
    for (const team of league.teams) {
      expect(team.players.length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("validateTeamData rejects malformed input", () => {
  it("throws on an out-of-range attribute (three: 120)", () => {
    const bad = makeTeam(makePlayer({ attributes: { ...makeAttributes(), three: 120 } }));
    expect(() => validateTeamData(bad, "in-memory")).toThrow();
  });

  it("throws on a missing tendency", () => {
    const tend = makeTendencies();
    delete (tend as Partial<PlayerData["tendencies"]>).driveRim;
    const bad = makeTeam(makePlayer({ tendencies: tend as PlayerData["tendencies"] }));
    expect(() => validateTeamData(bad, "in-memory")).toThrow();
  });

  it("throws on a bad position", () => {
    const bad = makeTeam(makePlayer({ position: "QB" as PlayerData["position"] }));
    expect(() => validateTeamData(bad, "in-memory")).toThrow();
  });
});

describe("toEnginePlayer mapping", () => {
  it("spreads attributes, derives tendShoot, sets arch/stats/tendencies", () => {
    const pd = makePlayer({
      tendencies: { ...makeTendencies(), shootThree: 60, shootMid: 35 },
    });
    const p: Player = toEnginePlayer(pd, "home");

    // spread attributes preserved verbatim
    for (const k of ATTR_KEYS) {
      expect(p.attr[k]).toBe(pd.attributes[k]);
    }
    // height carried onto attr
    expect(p.attr.height).toBe(pd.height);

    // derived tendShoot — exact formula
    const expected = clamp(
      0.3 + ((pd.tendencies.shootThree + pd.tendencies.shootMid) / 2 / 100) * 0.6,
      0.3,
      0.9,
    );
    expect(p.attr.tendShoot).toBe(expected);

    // archetype, side, identity
    expect(p.arch).toBe("custom");
    expect(p.team).toBe("home");
    expect(p.num).toBe(pd.number);
    expect(p.pos).toBe(pd.position);
    expect(p.name).toBe(pd.name);

    // zeroed stats
    for (const v of Object.values(p.stats)) {
      expect(v).toBe(0);
    }

    // attached tendencies (a copy, equal by value)
    expect(p.tendencies).toEqual(pd.tendencies);
  });

  it("all mapped ratings stay within [25,99] for every shipped player", () => {
    const league = loadLeagueFromDir("data");
    const everyone: PlayerData[] = [
      ...league.teams.flatMap((t) => t.players),
      ...league.freeAgents,
    ];
    for (const pd of everyone) {
      const p = toEnginePlayer(pd, "home");
      for (const k of ATTR_KEYS) {
        expect(p.attr[k]).toBeGreaterThanOrEqual(25);
        expect(p.attr[k]).toBeLessThanOrEqual(99);
      }
    }
  });
});

describe("deterministic loaded game (engine invariant + golden)", () => {
  const SEED = 7;
  const TICKS = 3000;

  function sumPts(team: Player[]): number {
    return team.reduce((acc, p) => acc + p.stats.pts, 0);
  }

  it("score equals sum of player points; matches golden final score", () => {
    const league = loadLeagueFromDir("data");
    const home = league.teams.find((t) => t.id === "harbor-city-wolves")!;
    const away = league.teams.find((t) => t.id === "summit-valley-rampart")!;

    const homeRoster = teamToEnginePlayers(home, "home");
    const awayRoster = teamToEnginePlayers(away, "away");

    seedRng(SEED);
    newGame(SEED, { home: homeRoster, away: awayRoster });
    G.homeAttack = "R";
    G.awayAttack = "L";
    G.attackHoop = "R";

    for (let i = 0; i < TICKS; i++) tick();

    // engine invariant: scoreboard == sum of player points
    expect(G.score.home).toBe(sumPts(G.home));
    expect(G.score.away).toBe(sumPts(G.away));

    // GOLDEN (discovered from a verified run with loaded rosters):
    expect(G.score.home).toBe(GOLDEN.homeScore);
    expect(G.score.away).toBe(GOLDEN.awayScore);
  });
});

describe("free agents optional", () => {
  it("validateFreeAgentsData accepts an empty players array", () => {
    expect(() => validateFreeAgentsData({ players: [] }, "in-memory")).not.toThrow();
    const fa = validateFreeAgentsData({ players: [] }, "in-memory");
    expect(fa.players).toEqual([]);
  });
});

// GOLDEN — discovered by running the loaded-roster game (seed 7, 3000 ticks).
const GOLDEN = {
  homeScore: 7,
  awayScore: 15,
};
