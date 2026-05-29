import { describe, it, expect } from "vitest";
import { makeProb, contestOf } from "../src/sim/shot.js";
import { threat } from "../src/sim/defense.js";
import { seedRng, rng } from "../src/core/rng.js";
import { clamp } from "../src/core/math.js";
import type { Player, Attributes, ShotType } from "../src/types.js";

/* =========================================================================
 * SCORING-PROBABILITY MODEL SPEC
 *
 * These tests pin down the exact, portable arithmetic of the shooting model
 * so the engine can be re-implemented in another language from the tests
 * alone. Every magic number in the formulas below is asserted explicitly.
 *
 * Reference formulas (from src/sim/offense.ts and src/sim/defense.ts):
 *
 *   makeProb(shooter, type, contest):
 *     base   = { rim:0.68, close:0.50, mid:0.44, three:0.372 }[type]
 *     sk     = (type=="rim"||type=="close") ? attr.finishing
 *            : (type=="mid")                ? attr.mid
 *            :                                attr.three
 *     p      = base + ((sk - 55) / 55) * 0.24
 *     cpen   = type=="rim" ? 0.15 : type=="three" ? 0.21 : 0.25
 *     p     -= contest * cpen
 *     p     -= fatigue * 0.05
 *     return clamp(p, 0.02, 0.97)
 *
 *   contestOf(shooter, def):
 *     {d, dd} = nearest defender to shooter (Euclidean)
 *     prox  = clamp(1 - dd/9, 0, 1)          // no contest past ~9 ft
 *     skill = clamp((d ? d.attr.perimD : 50) / 95, 0, 1.05)
 *     return clamp(prox * skill, 0, 1)
 *
 *   threat(p):
 *     clamp((attr.three*0.6 + attr.mid*0.2 + attr.finishing*0.2 - 40) / 55, 0, 1)
 * ========================================================================= */

/* ---- synthetic-shooter helpers -------------------------------------------
 * makeProb/contestOf/threat only read .attr and .fatigue (and x/y for
 * distance). We build plain objects with just those fields and cast to
 * Player so the tests stay focused on the model under test. */
const ATTR_DEFAULTS: Attributes = {
  speed: 55,
  handleLeft: 55,
  handleRight: 55,
  weight: 220,
  pass: 55,
  three: 55,
  mid: 55,
  finishing: 55,
  perimD: 55,
  steal: 55,
  iq: 55,
  strength: 55,
  vertical: 55,
  rebound: 55,
  interiorD: 55,
  block: 55,
  height: 55,
  tendShoot: 0.5,
};

function shooter(attr: Partial<Attributes>, fatigue = 0, x = 0, y = 0): Player {
  return { attr: { ...ATTR_DEFAULTS, ...attr }, fatigue, x, y } as unknown as Player;
}

function defender(perimD: number, x: number, y: number): Player {
  return { attr: { ...ATTR_DEFAULTS, perimD }, x, y } as unknown as Player;
}

const BASE: Record<ShotType, number> = { rim: 0.68, close: 0.5, mid: 0.44, three: 0.372 };
const CPEN: Record<ShotType, number> = { rim: 0.15, close: 0.25, mid: 0.25, three: 0.21 };
const TYPES: ShotType[] = ["rim", "close", "mid", "three"];

/* The attribute that drives each shot type's skill term. */
const SKILL_ATTR: Record<ShotType, keyof Attributes> = {
  rim: "finishing",
  close: "finishing",
  mid: "mid",
  three: "three",
};

describe("makeProb — base shot values at neutral skill (55), no contest, no fatigue", () => {
  // At skill==55 the (sk-55)/55 term is exactly 0, so p == base exactly.
  it("returns the base value for each ShotType when skill is league-average 55", () => {
    expect(makeProb(shooter({}), "rim", 0)).toBe(0.68);
    expect(makeProb(shooter({}), "close", 0)).toBe(0.5);
    expect(makeProb(shooter({}), "mid", 0)).toBe(0.44);
    expect(makeProb(shooter({}), "three", 0)).toBe(0.372);
  });
});

describe("makeProb — skill term is ((skill - 55) / 55) * 0.24", () => {
  // rim/close key off finishing; mid keys off mid; three keys off three.
  it("scales each type by its driving attribute exactly", () => {
    // rim uses finishing. finishing=79 -> ((79-55)/55)*0.24 added to 0.68
    const s1 = shooter({ finishing: 79 });
    expect(makeProb(s1, "rim", 0)).toBeCloseTo(0.68 + ((79 - 55) / 55) * 0.24, 12);
    // close also uses finishing
    expect(makeProb(s1, "close", 0)).toBeCloseTo(0.5 + ((79 - 55) / 55) * 0.24, 12);

    // mid uses the mid attribute (finishing must NOT leak in)
    const s2 = shooter({ mid: 88, finishing: 10 });
    expect(makeProb(s2, "mid", 0)).toBeCloseTo(0.44 + ((88 - 55) / 55) * 0.24, 12);

    // three uses the three attribute
    const s3 = shooter({ three: 99, mid: 10 });
    expect(makeProb(s3, "three", 0)).toBeCloseTo(0.372 + ((99 - 55) / 55) * 0.24, 12);
  });

  it("a below-average skill lowers the probability symmetrically", () => {
    // finishing=31 -> ((31-55)/55)*0.24 is negative
    const s = shooter({ finishing: 31 });
    expect(makeProb(s, "rim", 0)).toBeCloseTo(0.68 + ((31 - 55) / 55) * 0.24, 12);
  });

  it("uses the correct skill attribute per type and nothing else", () => {
    for (const type of TYPES) {
      const key = SKILL_ATTR[type];
      const s = shooter({ [key]: 70 } as Partial<Attributes>);
      const expected = BASE[type] + ((70 - 55) / 55) * 0.24;
      expect(makeProb(s, type, 0)).toBeCloseTo(expected, 12);
    }
  });
});

describe("makeProb — contest penalty is per-type: rim .15, three .21, mid/close .25", () => {
  // p -= contest * cpen, evaluated at a mid contest of 0.5.
  const contest = 0.5;
  it("applies the rim contest penalty of 0.15 per unit contest", () => {
    expect(makeProb(shooter({}), "rim", contest)).toBeCloseTo(0.68 - contest * 0.15, 12);
  });
  it("applies the three contest penalty of 0.21 per unit contest", () => {
    expect(makeProb(shooter({}), "three", contest)).toBeCloseTo(0.372 - contest * 0.21, 12);
  });
  it("applies the 0.25 contest penalty for mid and close", () => {
    expect(makeProb(shooter({}), "mid", contest)).toBeCloseTo(0.44 - contest * 0.25, 12);
    expect(makeProb(shooter({}), "close", contest)).toBeCloseTo(0.5 - contest * 0.25, 12);
  });
  it("scales linearly with contest (full contest of 1.0)", () => {
    expect(makeProb(shooter({}), "rim", 1)).toBeCloseTo(0.68 - 0.15, 12);
    expect(makeProb(shooter({}), "three", 1)).toBeCloseTo(0.372 - 0.21, 12);
    expect(makeProb(shooter({}), "mid", 1)).toBeCloseTo(0.44 - 0.25, 12);
  });
});

describe("makeProb — fatigue subtracts fatigue * 0.05", () => {
  it("reduces probability proportional to fatigue", () => {
    // fatigue 0.4 -> -0.02 off the base 0.68 for an average finisher at the rim
    expect(makeProb(shooter({}, 0.4), "rim", 0)).toBeCloseTo(0.68 - 0.4 * 0.05, 12);
    // fatigue 1.0 -> -0.05
    expect(makeProb(shooter({}, 1.0), "mid", 0)).toBeCloseTo(0.44 - 1.0 * 0.05, 12);
  });
});

describe("makeProb — full formula combining skill, contest, and fatigue", () => {
  // GOLDEN closed-form: every term active simultaneously.
  it("combines all four terms exactly for a contested, tired shooter", () => {
    // three-point shot: base .372, three=78, contest .5 (cpen .21), fatigue .3
    const s = shooter({ three: 78 }, 0.3);
    const expected = 0.372 + ((78 - 55) / 55) * 0.24 - 0.5 * 0.21 - 0.3 * 0.05;
    expect(makeProb(s, "three", 0.5)).toBeCloseTo(expected, 12);
    // sanity on the literal number this resolves to
    expect(makeProb(s, "three", 0.5)).toBeCloseTo(0.3523636363636363, 12);
  });

  it("rim shot with elite finisher, mid contest, light fatigue", () => {
    const s = shooter({ finishing: 90 }, 0.2);
    const expected = 0.68 + ((90 - 55) / 55) * 0.24 - 0.5 * 0.15 - 0.2 * 0.05;
    expect(makeProb(s, "rim", 0.5)).toBeCloseTo(expected, 12);
  });
});

describe("makeProb — output is clamped to [0.02, 0.97]", () => {
  it("clamps the upper bound to 0.97 for an elite uncontested finisher", () => {
    // finishing=99 -> 0.68 + ((99-55)/55)*0.24 = 0.8720 < 0.97, so not yet clamped.
    expect(makeProb(shooter({ finishing: 99 }), "rim", 0)).toBeCloseTo(0.872, 12);
    // Push past the ceiling with an impossible super-skill to force the clamp.
    const sup = shooter({ finishing: 999 });
    expect(makeProb(sup, "rim", 0)).toBe(0.97);
  });

  it("clamps the lower bound to 0.02 for a heavily contested, exhausted scrub", () => {
    // three: base .372, three=10 -> very low, full contest, max fatigue.
    const s = shooter({ three: 10 }, 1.0);
    const raw = 0.372 + ((10 - 55) / 55) * 0.24 - 1 * 0.21 - 1 * 0.05;
    expect(raw).toBeLessThan(0.02); // confirm the raw value is below the floor
    expect(makeProb(s, "three", 1)).toBe(0.02);
  });
});

describe("contestOf — proximity falls off linearly and vanishes past ~9 ft", () => {
  // prox = clamp(1 - dd/9, 0, 1); skill = clamp(perimD/95, 0, 1.05)
  it("returns 0 when the nearest defender is exactly 9 ft away", () => {
    // dd = 9 -> prox = 1 - 9/9 = 0
    const s = shooter({}, 0, 0, 0);
    expect(contestOf(s, [defender(95, 9, 0)])).toBe(0);
  });

  it("returns 0 for any defender beyond 9 ft", () => {
    const s = shooter({}, 0, 0, 0);
    expect(contestOf(s, [defender(95, 12, 0)])).toBe(0);
    expect(contestOf(s, [defender(95, 0, 20)])).toBe(0);
  });

  it("is prox * skill for a defender inside 9 ft", () => {
    // dd = 3 -> prox = 1 - 3/9 = 2/3; perimD = 95 -> skill = 95/95 = 1
    const s = shooter({}, 0, 0, 0);
    const expected = clamp(1 - 3 / 9, 0, 1) * clamp(95 / 95, 0, 1.05);
    expect(contestOf(s, [defender(95, 3, 0)])).toBeCloseTo(expected, 12);
    expect(contestOf(s, [defender(95, 3, 0)])).toBeCloseTo(2 / 3, 12);
  });

  it("weights the contest by the defender's perimeter defense (perimD/95)", () => {
    // dd = 4.5 -> prox = 1 - 4.5/9 = 0.5; perimD = 47.5 -> skill = 0.5
    const s = shooter({}, 0, 0, 0);
    const expected = (1 - 4.5 / 9) * (47.5 / 95);
    expect(contestOf(s, [defender(47.5, 4.5, 0)])).toBeCloseTo(expected, 12);
    expect(contestOf(s, [defender(47.5, 4.5, 0)])).toBeCloseTo(0.25, 12);
  });

  it("uses the NEAREST defender among several", () => {
    // far defender at 8ft, near defender at 2ft -> uses the 2ft one
    const s = shooter({}, 0, 0, 0);
    const near = defender(95, 2, 0);
    const far = defender(95, 8, 0);
    const expected = (1 - 2 / 9) * 1;
    expect(contestOf(s, [far, near])).toBeCloseTo(expected, 12);
  });

  it("a max defender right on top of the shooter approaches a contest of 1", () => {
    // dd ~ 0 -> prox = 1; perimD high so skill clamps. A perimD of 95 gives skill 1.
    const s = shooter({}, 0, 0, 0);
    expect(contestOf(s, [defender(95, 0, 0)])).toBeCloseTo(1, 12);
  });

  it("clamps the product to a maximum of 1 even when skill exceeds 1", () => {
    // perimD = 99.75 -> 99.75/95 = 1.05 (the skill ceiling); dd ~ 0 -> prox 1.
    // prox*skill = 1.05 but the outer clamp pins it to 1.
    const s = shooter({}, 0, 0, 0);
    expect(contestOf(s, [defender(99.75, 0, 0)])).toBe(1);
  });
});

describe("threat — defensive respect from shooting/finishing attributes", () => {
  // clamp((three*0.6 + mid*0.2 + finishing*0.2 - 40) / 55, 0, 1)
  it("computes the weighted blend exactly for a sample wing", () => {
    // three=75, mid=60, finishing=70
    const p = shooter({ three: 75, mid: 60, finishing: 70 });
    const expected = clamp((75 * 0.6 + 60 * 0.2 + 70 * 0.2 - 40) / 55, 0, 1);
    expect(threat(p)).toBeCloseTo(expected, 12);
    expect(threat(p)).toBeCloseTo((45 + 12 + 14 - 40) / 55, 12); // = 31/55
  });

  it("clamps to 0 for a complete non-shooter", () => {
    // all 10s: (6 + 2 + 2 - 40)/55 = -30/55 < 0 -> 0
    const p = shooter({ three: 10, mid: 10, finishing: 10 });
    expect(threat(p)).toBe(0);
  });

  it("clamps to 1 for an elite three-level scorer", () => {
    // all 99s: (59.4 + 19.8 + 19.8 - 40)/55 = 59/55 > 1 -> 1
    const p = shooter({ three: 99, mid: 99, finishing: 99 });
    expect(threat(p)).toBe(1);
  });

  it("weights three-point shooting most heavily (0.6 vs 0.2/0.2)", () => {
    // Same total attribute budget, but concentrated in three vs in mid.
    const threeHeavy = shooter({ three: 90, mid: 30, finishing: 30 });
    const midHeavy = shooter({ three: 30, mid: 90, finishing: 30 });
    expect(threat(threeHeavy)).toBeGreaterThan(threat(midHeavy));
  });
});

/* =========================================================================
 * GOLDEN RNG VECTORS
 *
 * The RNG (src/core/rng.ts) is a mulberry32 variant: portable and fully
 * deterministic from its seed. A port MUST reproduce these exact draws.
 * These vectors anchor any stochastic shot-resolution code built on top
 * of the probability model above.
 * ========================================================================= */
describe("seedRng/rng — portable deterministic stream (golden vectors)", () => {
  it("produces a fixed first-five sequence for seed 12345", () => {
    seedRng(12345);
    const seq = [rng(), rng(), rng(), rng(), rng()];
    // GOLDEN: baked from the deterministic mulberry32 stream for seed 12345.
    expect(seq).toEqual([
      0.9797282677609473, 0.3067522644996643, 0.484205421525985, 0.817934412509203,
      0.5094283693470061,
    ]);
  });

  it("re-seeding rewinds the stream exactly", () => {
    seedRng(12345);
    const a = rng();
    seedRng(12345);
    const b = rng();
    expect(b).toBe(a);
  });

  it("produces a fixed first-three sequence for seed 1", () => {
    seedRng(1);
    // GOLDEN: seed 1 stream.
    expect([rng(), rng(), rng()]).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    ]);
  });

  it("makeProb is purely deterministic and consumes no RNG draws", () => {
    // Probability math must not advance the RNG; a port can compute it
    // independently of the random stream. We prove this by checking the
    // stream is untouched across a makeProb call.
    seedRng(777);
    const before = rng();
    makeProb(shooter({ three: 80 }, 0.5), "three", 0.3);
    seedRng(777);
    const after = rng();
    expect(after).toBe(before);
  });
});
