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
//   steal, iq, strength, vertical, rebound, interiorD, block, drawFoul, discipline,
//   height, tendShoot
// handleLeft and handleRight each get their OWN draw (a player's off-hand varies
// independently); weight is DERIVED from height after the loop (no rng draw). So
// 19 randn() calls per player (17 ratings + height + tendShoot; each randn = 2 base
// rng() draws, redraw-on-zero), then 1 name pop. genTeam additionally consumes one
// rng() draw up front for the chance(0.5) slasher swap.

// The 25..99 rating attributes (everything except height/tendShoot).
const RATING_KEYS: (keyof ArchetypeTemplate)[] = [
  "speed", "handleLeft", "handleRight", "pass", "three", "mid", "finishing", "perimD",
  "steal", "iq", "strength", "vertical", "rebound", "interiorD", "block",
  "drawFoul", "discipline",
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
    { num: 1, pos: "PG", arch: "floor_gen", name: "Ferro", attr: { speed: 77, handleLeft: 68, handleRight: 92, pass: 96, three: 75, mid: 69, finishing: 81, perimD: 73, steal: 78, iq: 87, strength: 57, vertical: 69, rebound: 49, interiorD: 60, block: 32, drawFoul: 60, discipline: 76, height: 6.24, tendShoot: 0.5686070666425965, weight: 186 } },
    { num: 3, pos: "SG", arch: "slasher", name: "Hahn", attr: { speed: 93, handleLeft: 81, handleRight: 82, pass: 75, three: 68, mid: 69, finishing: 81, perimD: 75, steal: 75, iq: 86, strength: 78, vertical: 85, rebound: 55, interiorD: 52, block: 51, drawFoul: 84, discipline: 54, height: 6.4, tendShoot: 0.7041828298713322, weight: 203 } },
    { num: 7, pos: "SF", arch: "wing_3d", name: "Crane", attr: { speed: 81, handleLeft: 72, handleRight: 44, pass: 59, three: 73, mid: 68, finishing: 87, perimD: 81, steal: 76, iq: 81, strength: 71, vertical: 78, rebound: 67, interiorD: 68, block: 53, drawFoul: 47, discipline: 54, height: 6.56, tendShoot: 0.5080825940613846, weight: 219 } },
    { num: 21, pos: "PF", arch: "stretch_4", name: "Costa", attr: { speed: 74, handleLeft: 39, handleRight: 65, pass: 69, three: 84, mid: 70, finishing: 89, perimD: 71, steal: 60, iq: 89, strength: 69, vertical: 78, rebound: 78, interiorD: 81, block: 63, drawFoul: 62, discipline: 71, height: 7.06, tendShoot: 0.5268618302508531, weight: 248 } },
    { num: 33, pos: "C", arch: "rim_big", name: "Tanaka", attr: { speed: 60, handleLeft: 35, handleRight: 40, pass: 61, three: 37, mid: 58, finishing: 96, perimD: 51, steal: 43, iq: 75, strength: 93, vertical: 75, rebound: 84, interiorD: 85, block: 87, drawFoul: 70, discipline: 50, height: 6.92, tendShoot: 0.49258789185543433, weight: 264 } },
  ];

  const AWAY_GOLDEN = [
    { num: 41, pos: "PG", arch: "floor_gen", name: "Mensah", attr: { speed: 99, handleLeft: 84, handleRight: 82, pass: 98, three: 68, mid: 77, finishing: 83, perimD: 74, steal: 82, iq: 92, strength: 63, vertical: 81, rebound: 44, interiorD: 52, block: 41, drawFoul: 49, discipline: 78, height: 6.13, tendShoot: 0.6336232502916539, weight: 184 } },
    { num: 43, pos: "SG", arch: "slasher", name: "Reyes", attr: { speed: 90, handleLeft: 73, handleRight: 84, pass: 76, three: 55, mid: 68, finishing: 83, perimD: 82, steal: 78, iq: 72, strength: 74, vertical: 94, rebound: 59, interiorD: 56, block: 51, drawFoul: 92, discipline: 58, height: 6.68, tendShoot: 0.6706764269483884, weight: 208 } },
    { num: 47, pos: "SF", arch: "wing_3d", name: "Ade", attr: { speed: 83, handleLeft: 71, handleRight: 60, pass: 63, three: 87, mid: 78, finishing: 75, perimD: 84, steal: 77, iq: 87, strength: 83, vertical: 86, rebound: 61, interiorD: 83, block: 55, drawFoul: 66, discipline: 70, height: 6.57, tendShoot: 0.4251584126630929, weight: 219 } },
    { num: 61, pos: "PF", arch: "stretch_4", name: "Dumas", attr: { speed: 60, handleLeft: 41, handleRight: 57, pass: 58, three: 85, mid: 83, finishing: 94, perimD: 58, steal: 61, iq: 75, strength: 78, vertical: 83, rebound: 79, interiorD: 80, block: 62, drawFoul: 80, discipline: 68, height: 6.92, tendShoot: 0.6066927060180769, weight: 245 } },
    { num: 73, pos: "C", arch: "rim_big", name: "Bjork", attr: { speed: 65, handleLeft: 25, handleRight: 49, pass: 63, three: 36, mid: 57, finishing: 88, perimD: 59, steal: 48, iq: 83, strength: 90, vertical: 80, rebound: 89, interiorD: 85, block: 93, drawFoul: 85, discipline: 72, height: 6.79, tendShoot: 0.40753060180945677, weight: 261 } },
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
      interiorD: 54, block: 36, drawFoul: 55, discipline: 88, height: 6.16, tendShoot: 0.5786753411805927, weight: 184,
    });
  });

  it("initializes counting stats to zero and default role/flags", () => {
    seedRng(42);
    resetNamePool();
    const p = genPlayer("rim_big", "home", 33);
    expect(p.stats).toEqual({
      pts: 0, fga: 0, fgm: 0, tpa: 0, tpm: 0, rimFga: 0, reb: 0, ast: 0,
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
