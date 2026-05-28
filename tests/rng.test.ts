import { seedRng, rng } from "../src/core/rng.js";
import { rnd, chance, randn } from "../src/core/math.js";

// These tests pin down the portable, reproducible RNG so the engine can be
// re-implemented in another language from the golden vectors alone.
//
// Algorithm (src/core/rng.ts) — a mulberry32-style generator over a uint32 state:
//   seedRng(seed): _state = seed >>> 0
//   rng():
//     _state = (_state + 0x6d2b79f5) >>> 0
//     let t = _state
//     t = imul(t ^ (t >>> 15), 1 | t)
//     t = (t + imul(t ^ (t >>> 7), 61 | t)) ^ t
//     return ((t ^ (t >>> 14)) >>> 0) / 4294967296
// All arithmetic is 32-bit unsigned (Math.imul = 32-bit multiply).

describe("rng: seedRng + rng golden sequence (seed = 1)", () => {
  // GOLDEN VECTOR: first 8 outputs of rng() after seedRng(1).
  // A correct port MUST reproduce these exact doubles.
  const SEED1_FIRST8 = [
    0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    0.9810509674716741, 0.9683778982143849, 0.281103502959013,
    0.6128388606011868, 0.7207431411370635,
  ];

  it("produces the exact golden floats for seed 1", () => {
    seedRng(1);
    for (let i = 0; i < SEED1_FIRST8.length; i++) {
      expect(rng()).toBe(SEED1_FIRST8[i]);
    }
  });
});

describe("rng: determinism", () => {
  it("the same seed reproduces the same sequence", () => {
    seedRng(42);
    const a = Array.from({ length: 16 }, () => rng());
    seedRng(42);
    const b = Array.from({ length: 16 }, () => rng());
    expect(b).toEqual(a);
  });

  it("different seeds produce different sequences", () => {
    seedRng(1);
    const a = Array.from({ length: 8 }, () => rng());
    seedRng(2);
    const b = Array.from({ length: 8 }, () => rng());
    expect(b).not.toEqual(a);

    // GOLDEN VECTOR: first 8 outputs of rng() after seedRng(2).
    expect(b).toEqual([
      0.7342509443406016, 0.32499843230471015, 0.28529605525545776,
      0.5379551574587822, 0.8752879470121115, 0.6308333419729024,
      0.4992015736643225, 0.3572446557227522,
    ]);
  });

  it("seed is masked to uint32 (seedRng(seed >>> 0))", () => {
    // seed 1 and seed (1 + 2^32) collapse to the same uint32 state.
    seedRng(1);
    const a = Array.from({ length: 4 }, () => rng());
    seedRng(1 + 2 ** 32);
    const b = Array.from({ length: 4 }, () => rng());
    expect(b).toEqual(a);
  });
});

describe("rng: range invariant — rng() in [0, 1)", () => {
  it("every output is >= 0 and < 1", () => {
    seedRng(7);
    for (let i = 0; i < 100000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("math: rnd(a, b) = a + rng() * (b - a)", () => {
  it("returns the exact golden value at a fixed seed", () => {
    // GOLDEN VECTOR: with seedRng(1), first rng() = 0.6270739405881613,
    // so rnd(5, 10) = 5 + 0.6270739405881613 * 5 = 8.135369702940807.
    seedRng(1);
    expect(rnd(5, 10)).toBe(8.135369702940807);
  });

  it("stays within [a, b) over many draws", () => {
    seedRng(3);
    const a = -2,
      b = 7;
    for (let i = 0; i < 100000; i++) {
      const x = rnd(a, b);
      expect(x).toBeGreaterThanOrEqual(a);
      expect(x).toBeLessThan(b);
    }
  });
});

describe("math: chance(p) = rng() < p", () => {
  it("frequency over many seeded draws is near p", () => {
    seedRng(12345);
    const p = 0.3;
    const N = 200000;
    let hits = 0;
    for (let i = 0; i < N; i++) {
      if (chance(p)) hits++;
    }
    const freq = hits / N;
    // Golden: with seedRng(12345), freq = 0.301385 over 200k draws.
    expect(freq).toBeCloseTo(p, 2);
  });

  it("chance(0) is always false and chance(1) is always true", () => {
    seedRng(1);
    for (let i = 0; i < 1000; i++) expect(chance(0)).toBe(false);
    seedRng(1);
    for (let i = 0; i < 1000; i++) expect(chance(1)).toBe(true);
  });
});

describe("math: randn() — Box-Muller standard normal", () => {
  // randn(): draw u, v (rejecting 0) and return
  //   sqrt(-2 * ln(u)) * cos(2 * PI * v)
  it("returns the exact golden value at a fixed seed", () => {
    // GOLDEN VECTOR: with seedRng(1), u = 0.6270739405881613,
    // v = 0.002735721180215478, giving randn() = 0.9659740590152261.
    seedRng(1);
    expect(randn()).toBe(0.9659740590152261);
  });

  it("mean is ~0 over many draws", () => {
    seedRng(999);
    const M = 200000;
    let sum = 0;
    for (let i = 0; i < M; i++) sum += randn();
    const mean = sum / M;
    // Golden: with seedRng(999), mean = 0.0004960603191759693.
    expect(Math.abs(mean)).toBeLessThan(0.02);
  });
});
