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
// while a draw is exactly 0. The order template keys are visited is the object key
// insertion order of ArchetypeTemplate / each archetype's `t`, which is:
//   speed, handle, pass, three, mid, finishing, perimD, steal, iq, strength,
//   vertical, rebound, interiorD, block, height, tendShoot
// so 16 randn() calls per player (one per attribute; each randn = 2 base rng() draws,
// with redraw-on-zero), then 1 name pop per player. genTeam additionally consumes one
// rng() draw up front for the chance(0.5) slasher swap.

// The 25..99 rating attributes (everything except height/tendShoot).
const RATING_KEYS: (keyof ArchetypeTemplate)[] = [
  "speed", "handle", "pass", "three", "mid", "finishing", "perimD",
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
    { num: 1, pos: "PG", arch: "floor_gen", name: "Ferro", attr: { speed: 77, handle: 84, pass: 94, three: 82, mid: 77, finishing: 67, perimD: 77, steal: 79, iq: 88, strength: 57, vertical: 67, rebound: 44, interiorD: 59, block: 40, height: 6.15, tendShoot: 0.5343268832949084 } },
    { num: 3, pos: "SG", arch: "slasher", name: "Hahn", attr: { speed: 86, handle: 87, pass: 76, three: 67, mid: 84, finishing: 85, perimD: 77, steal: 82, iq: 75, strength: 63, vertical: 87, rebound: 49, interiorD: 68, block: 56, height: 6.44, tendShoot: 0.7015698220209964 } },
    { num: 7, pos: "SF", arch: "wing_3d", name: "Crane", attr: { speed: 74, handle: 75, pass: 62, three: 79, mid: 67, finishing: 83, perimD: 89, steal: 82, iq: 70, strength: 67, vertical: 75, rebound: 58, interiorD: 77, block: 49, height: 6.49, tendShoot: 0.5047082099487633 } },
    { num: 21, pos: "PF", arch: "stretch_4", name: "Costa", attr: { speed: 67, handle: 58, pass: 69, three: 80, mid: 73, finishing: 69, perimD: 55, steal: 58, iq: 77, strength: 84, vertical: 75, rebound: 81, interiorD: 83, block: 68, height: 6.74, tendShoot: 0.6047732347201843 } },
    { num: 33, pos: "C", arch: "rim_big", name: "Tanaka", attr: { speed: 63, handle: 48, pass: 69, three: 29, mid: 55, finishing: 90, perimD: 58, steal: 47, iq: 66, strength: 91, vertical: 88, rebound: 89, interiorD: 94, block: 98, height: 6.84, tendShoot: 0.48845928256933824 } },
  ];

  const AWAY_GOLDEN = [
    { num: 41, pos: "PG", arch: "floor_gen", name: "Mensah", attr: { speed: 86, handle: 88, pass: 99, three: 69, mid: 79, finishing: 79, perimD: 69, steal: 74, iq: 83, strength: 56, vertical: 76, rebound: 44, interiorD: 49, block: 30, height: 6.44, tendShoot: 0.6415594069971968 } },
    { num: 43, pos: "SG", arch: "sharp", name: "Reyes", attr: { speed: 90, handle: 67, pass: 74, three: 82, mid: 81, finishing: 79, perimD: 72, steal: 72, iq: 80, strength: 65, vertical: 85, rebound: 47, interiorD: 52, block: 46, height: 6.14, tendShoot: 0.7643240957081662 } },
    { num: 47, pos: "SF", arch: "wing_3d", name: "Ade", attr: { speed: 78, handle: 82, pass: 66, three: 84, mid: 71, finishing: 82, perimD: 81, steal: 78, iq: 75, strength: 80, vertical: 82, rebound: 56, interiorD: 74, block: 64, height: 6.73, tendShoot: 0.46450684709059137 } },
    { num: 61, pos: "PF", arch: "stretch_4", name: "Dumas", attr: { speed: 73, handle: 66, pass: 67, three: 91, mid: 77, finishing: 83, perimD: 65, steal: 66, iq: 73, strength: 87, vertical: 84, rebound: 73, interiorD: 72, block: 61, height: 7.05, tendShoot: 0.6280988473651372 } },
    { num: 73, pos: "C", arch: "rim_big", name: "Bjork", attr: { speed: 62, handle: 47, pass: 69, three: 37, mid: 61, finishing: 95, perimD: 53, steal: 41, iq: 64, strength: 91, vertical: 75, rebound: 86, interiorD: 95, block: 95, height: 7.23, tendShoot: 0.37971063449035153 } },
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
      speed: 99, handle: 81, pass: 97, three: 75, mid: 80, finishing: 80,
      perimD: 77, steal: 92, iq: 96, strength: 53, vertical: 63, rebound: 44,
      interiorD: 46, block: 34, height: 6.21, tendShoot: 0.4878056441292982,
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
});
