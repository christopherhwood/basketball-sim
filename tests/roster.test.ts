import { describe, it, expect } from "vitest";
import { seedRng } from "../src/core/rng.js";
import { genPlayer, genTeam, resetNamePool } from "../src/data/roster.js";
import { ARCH, type ArchetypeTemplate } from "../src/data/archetypes.js";

// Roster generation spec.
//
// This file pins down deterministic player/team generation so the engine can be
// re-implemented in another language and verified against the same seeded RNG.
//
// Generation rules (src/data/roster.ts):
//   - Each archetype (src/data/archetypes.ts) carries a template `t` of base values.
//   - For each template key, genPlayer derives an attribute:
//       * "tendShoot": clamp(base + randn()*0.05, 0.3, 0.9)   (kept as raw float)
//       * "height":    +(base + randn()*0.12).toFixed(2)      (2-decimal float feet)
//       * everything else (a 25..99 rating):
//                      clamp(round(base + randn()*6), 25, 99)
//   - Names are popped off a name pool that is shuffled once via resetNamePool()
//     using `NAMES.slice().sort(() => rng() - 0.5)`.
//   - genTeam builds 5 players: ["floor_gen","sharp","wing_3d","stretch_4","rim_big"],
//     but with probability 0.5 (chance(0.5)) the index-1 "sharp" is swapped to "slasher".
//   - Jersey numbers come from base array [1,3,7,21,33]; the away team adds +40 to each.
//
// IMPORTANT: randn() consumes TWO rng() draws (Box-Muller), and it loops/redraws
// while a draw is exactly 0. Template keys are visited in object insertion order:
//   speed, handleLeft, handleRight, weight, pass, three, mid, finishing, perimD,
//   steal, iq, strength, vertical, rebound, interiorD, block, height, tendShoot
// handleLeft and handleRight each get their OWN draw (a player's off-hand varies
// independently); weight is DERIVED from height after the loop (no rng draw). So
// 17 randn() calls per player (15 ratings + height + tendShoot; each randn = 2 base
// rng() draws, redraw-on-zero), then 1 name pop. genTeam additionally consumes one
// rng() draw up front for the chance(0.5) slasher swap.

// The 25..99 rating attributes (everything except height/tendShoot).
const RATING_KEYS: (keyof ArchetypeTemplate)[] = [
  "speed", "handleLeft", "handleRight", "pass", "three", "mid", "finishing", "perimD",
  "steal", "iq", "strength", "vertical", "rebound", "interiorD", "block",
];

describe("genTeam: roster shape and positions", () => {
  // genTeam always produces exactly 5 players in PG/SG/SF/PF/C order.
  // Index 1 may be "sharp" (SG) or "slasher" (also pos SG) depending on chance(0.5),
  // so the position sequence is stable even when the archetype swaps.
  it("builds 5 players with positions PG, SG, SF, PF, C", () => {
    seedRng(42);
    resetNamePool();
    const team = genTeam("home");
    expect(team).toHaveLength(5);
    expect(team.map((p) => p.pos)).toEqual(["PG", "SG", "SF", "PF", "C"]);
  });

  it("index 1 is always either 'sharp' or 'slasher' (the slasher swap)", () => {
    // Run several seeds; index 1 archetype is one of the two SG builds, never anything else.
    for (const seed of [1, 2, 3, 7, 42, 99, 1000]) {
      seedRng(seed);
      resetNamePool();
      const team = genTeam("home");
      expect(["sharp", "slasher"]).toContain(team[1].arch);
      expect(team[1].pos).toBe("SG");
      // The other four slots are fixed.
      expect(team[0].arch).toBe("floor_gen");
      expect(team[2].arch).toBe("wing_3d");
      expect(team[3].arch).toBe("stretch_4");
      expect(team[4].arch).toBe("rim_big");
    }
  });
});

describe("jersey numbers", () => {
  // home uses base [1,3,7,21,33]; away adds +40 -> [41,43,47,61,73].
  it("home team uses [1, 3, 7, 21, 33]", () => {
    seedRng(42);
    resetNamePool();
    const team = genTeam("home");
    expect(team.map((p) => p.num)).toEqual([1, 3, 7, 21, 33]);
  });

  it("away team uses [41, 43, 47, 61, 73] (base + 40)", () => {
    seedRng(42);
    resetNamePool();
    // generate home first so the RNG stream matches the golden vector setup
    genTeam("home");
    const away = genTeam("away");
    expect(away.map((p) => p.num)).toEqual([41, 43, 47, 61, 73]);
  });
});

describe("attribute bounds (invariants for any seed)", () => {
  // Verify the clamp ranges hold across many seeds and both teams.
  it("every 25..99 rating stays within [25, 99]", () => {
    for (const seed of [1, 5, 13, 42, 256, 9999]) {
      seedRng(seed);
      resetNamePool();
      const players = [...genTeam("home"), ...genTeam("away")];
      for (const p of players) {
        for (const k of RATING_KEYS) {
          const v = p.attr[k];
          expect(v).toBeGreaterThanOrEqual(25);
          expect(v).toBeLessThanOrEqual(99);
          expect(Number.isInteger(v)).toBe(true);
        }
      }
    }
  });

  it("handleLeft/handleRight stay within [25, 99] and weight stays in a sane range", () => {
    for (const seed of [1, 5, 13, 42, 256, 9999]) {
      seedRng(seed);
      resetNamePool();
      const players = [...genTeam("home"), ...genTeam("away")];
      for (const p of players) {
        expect(p.attr.handleLeft).toBeGreaterThanOrEqual(25);
        expect(p.attr.handleLeft).toBeLessThanOrEqual(99);
        expect(p.attr.handleRight).toBeGreaterThanOrEqual(25);
        expect(p.attr.handleRight).toBeLessThanOrEqual(99);
        expect(Number.isInteger(p.attr.weight)).toBe(true);
        expect(p.attr.weight).toBeGreaterThanOrEqual(150);
        expect(p.attr.weight).toBeLessThanOrEqual(320);
      }
    }
  });

  it("tendShoot stays within [0.3, 0.9]", () => {
    for (const seed of [1, 5, 13, 42, 256, 9999]) {
      seedRng(seed);
      resetNamePool();
      const players = [...genTeam("home"), ...genTeam("away")];
      for (const p of players) {
        expect(p.attr.tendShoot).toBeGreaterThanOrEqual(0.3);
        expect(p.attr.tendShoot).toBeLessThanOrEqual(0.9);
      }
    }
  });

  it("height is base +/- ~0.12*randn, rounded to 2 decimals, near the template", () => {
    // height = +(template.height + randn()*0.12).toFixed(2)
    // randn is ~N(0,1); |height - template| should be within ~6 sigma = 0.72 ft for sane seeds.
    for (const seed of [1, 5, 13, 42, 256, 9999]) {
      seedRng(seed);
      resetNamePool();
      const players = [...genTeam("home"), ...genTeam("away")];
      for (const p of players) {
        const base = ARCH[p.arch].t.height;
        expect(Math.abs(p.attr.height - base)).toBeLessThan(0.75);
        // exactly 2 decimal places (toFixed(2))
        expect(Math.round(p.attr.height * 100)).toBeCloseTo(p.attr.height * 100, 9);
      }
    }
  });
});

describe("GOLDEN VECTOR: seedRng(42) + resetNamePool() then genTeam('home'), genTeam('away')", () => {
  // Exact deterministic output. A port using the same xorshift-ish RNG (src/core/rng.ts),
  // the same Box-Muller randn() (two draws, redraw-on-zero), the same key visitation order,
  // and the same name-pool shuffle MUST reproduce these values exactly.
  //
  // Setup: seedRng(42); resetNamePool(); home = genTeam("home"); away = genTeam("away");
  // For seed 42 the index-1 swap fires for HOME (-> "slasher") but NOT for AWAY (-> "sharp").

  const HOME_GOLDEN = [
    { num: 1, pos: "PG", arch: "floor_gen", name: "Ferro", attr: { speed: 77, handleLeft: 68, handleRight: 92, pass: 96, three: 75, mid: 69, finishing: 81, perimD: 73, steal: 78, iq: 87, strength: 57, vertical: 69, rebound: 49, interiorD: 60, block: 32, height: 6.16, tendShoot: 0.514815025746043, weight: 184 } },
    { num: 3, pos: "SG", arch: "slasher", name: "Hahn", attr: { speed: 92, handleLeft: 71, handleRight: 88, pass: 86, three: 61, mid: 73, finishing: 92, perimD: 73, steal: 71, iq: 77, strength: 67, vertical: 96, rebound: 60, interiorD: 57, block: 51, height: 6.33, tendShoot: 0.7040805068785624, weight: 202 } },
    { num: 7, pos: "SF", arch: "wing_3d", name: "Crane", attr: { speed: 78, handleLeft: 71, handleRight: 49, pass: 69, three: 79, mid: 72, finishing: 70, perimD: 83, steal: 75, iq: 76, strength: 81, vertical: 73, rebound: 56, interiorD: 71, block: 55, height: 6.51, tendShoot: 0.5421934096509999, weight: 218 } },
    { num: 21, pos: "PF", arch: "stretch_4", name: "Costa", attr: { speed: 68, handleLeft: 37, handleRight: 49, pass: 53, three: 80, mid: 79, finishing: 86, perimD: 63, steal: 63, iq: 81, strength: 82, vertical: 70, rebound: 85, interiorD: 83, block: 66, height: 7.16, tendShoot: 0.4558438714346441, weight: 250 } },
    { num: 33, pos: "C", arch: "rim_big", name: "Tanaka", attr: { speed: 58, handleLeft: 27, handleRight: 51, pass: 53, three: 32, mid: 54, finishing: 98, perimD: 52, steal: 52, iq: 82, strength: 84, vertical: 85, rebound: 89, interiorD: 95, block: 96, height: 6.92, tendShoot: 0.39189727919052947, weight: 264 } },
  ];

  const AWAY_GOLDEN = [
    { num: 41, pos: "PG", arch: "floor_gen", name: "Mensah", attr: { speed: 89, handleLeft: 69, handleRight: 84, pass: 85, three: 74, mid: 86, finishing: 77, perimD: 68, steal: 75, iq: 99, strength: 71, vertical: 80, rebound: 37, interiorD: 61, block: 25, height: 6.14, tendShoot: 0.5943272666612982, weight: 184 } },
    { num: 43, pos: "SG", arch: "sharp", name: "Reyes", attr: { speed: 80, handleLeft: 60, handleRight: 77, pass: 71, three: 99, mid: 83, finishing: 71, perimD: 78, steal: 57, iq: 76, strength: 58, vertical: 84, rebound: 48, interiorD: 59, block: 39, height: 6.45, tendShoot: 0.7037376155317344, weight: 201 } },
    { num: 47, pos: "SF", arch: "wing_3d", name: "Ade", attr: { speed: 78, handleLeft: 67, handleRight: 60, pass: 66, three: 74, mid: 76, finishing: 86, perimD: 97, steal: 78, iq: 83, strength: 78, vertical: 85, rebound: 71, interiorD: 69, block: 59, height: 6.58, tendShoot: 0.5523780125597801, weight: 220 } },
    { num: 61, pos: "PF", arch: "stretch_4", name: "Dumas", attr: { speed: 67, handleLeft: 49, handleRight: 68, pass: 59, three: 76, mid: 73, finishing: 89, perimD: 75, steal: 64, iq: 75, strength: 93, vertical: 75, rebound: 84, interiorD: 83, block: 64, height: 6.72, tendShoot: 0.4661574023570383, weight: 242 } },
    { num: 73, pos: "C", arch: "rim_big", name: "Bjork", attr: { speed: 57, handleLeft: 25, handleRight: 42, pass: 59, three: 45, mid: 67, finishing: 82, perimD: 56, steal: 49, iq: 72, strength: 97, vertical: 81, rebound: 94, interiorD: 88, block: 99, height: 6.92, tendShoot: 0.4568918124805992, weight: 264 } },
  ];

  function snapshot(p: ReturnType<typeof genPlayer>) {
    return { num: p.num, pos: p.pos, arch: p.arch, name: p.name, attr: { ...p.attr } };
  }

  it("HOME matches the golden vector exactly", () => {
    seedRng(42);
    resetNamePool();
    const home = genTeam("home");
    expect(home.map(snapshot)).toEqual(HOME_GOLDEN);
  });

  it("AWAY (generated immediately after HOME) matches the golden vector exactly", () => {
    seedRng(42);
    resetNamePool();
    genTeam("home"); // advance the RNG stream as in the golden setup
    const away = genTeam("away");
    expect(away.map(snapshot)).toEqual(AWAY_GOLDEN);
  });
});

describe("genPlayer: single-player determinism and structure", () => {
  // genTeam calls chance(0.5) (one rng() draw) BEFORE generating the first player,
  // so a standalone genPlayer right after seed+shuffle does NOT match genTeam's slot 0
  // (its attribute draws are shifted by one rng() consumption). The name pool, however,
  // is shuffled by resetNamePool() and is unaffected, so the first popped name is still
  // "Ferro". This golden vector is the standalone genPlayer("floor_gen") output.
  it("standalone genPlayer('floor_gen') is deterministic (no preceding chance() draw)", () => {
    seedRng(42);
    resetNamePool();
    const lone = genPlayer("floor_gen", "home", 1);
    expect(lone.num).toBe(1);
    expect(lone.pos).toBe("PG");
    expect(lone.arch).toBe("floor_gen");
    expect(lone.name).toBe("Ferro");
    expect(lone.attr).toEqual({
      speed: 99, handleLeft: 65, handleRight: 95, pass: 89, three: 78, mid: 82, finishing: 81,
      perimD: 86, steal: 86, iq: 83, strength: 53, vertical: 69, rebound: 36,
      interiorD: 54, block: 36, height: 6.05, tendShoot: 0.6128711410764927, weight: 182,
    });
  });

  it("initializes counting stats to zero and default role/flags", () => {
    seedRng(42);
    resetNamePool();
    const p = genPlayer("rim_big", "home", 33);
    expect(p.stats).toEqual({
      pts: 0, fga: 0, fgm: 0, tpa: 0, tpm: 0, reb: 0, ast: 0,
      stl: 0, blk: 0, tov: 0, fta: 0, ftm: 0,
    });
    expect(p.role).toBe("spacer");
    expect(p.hasBall).toBe(false);
    expect(p.fatigue).toBe(0);
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
  });

  it("derives every attribute key present on the archetype template", () => {
    seedRng(7);
    resetNamePool();
    const p = genPlayer("sharp", "away", 43);
    for (const k in ARCH.sharp.t) {
      expect(p.attr).toHaveProperty(k);
    }
  });

  it("copies tendencies verbatim from the archetype (no rng-derived noise)", () => {
    // Tendencies were added to generation as a plain copy of ARCH[arch].tend,
    // consuming no rng draws, so they must equal the archetype's tend exactly
    // and be a distinct object (a defensive copy, not the shared template).
    for (const archKey of ["floor_gen", "sharp", "wing_3d", "stretch_4", "rim_big", "slasher"]) {
      seedRng(42);
      resetNamePool();
      const p = genPlayer(archKey, "home", 1);
      expect(p.tendencies).toEqual(ARCH[archKey].tend);
      expect(p.tendencies).not.toBe(ARCH[archKey].tend);
    }
  });
});
