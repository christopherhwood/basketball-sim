import { maxSpeed, moveAll } from "../src/sim/movement.js";
import { newGame, G, players } from "../src/core/state.js";
import { seedRng } from "../src/core/rng.js";
import { COURT_L, COURT_W, DT } from "../src/core/constants.js";
import type { Player } from "../src/types.js";

/* Pins down src/sim/movement.ts.
 *
 * Court geometry (from constants.ts):
 *   COURT_L = 94, COURT_W = 50, DT = 0.1 (seconds per tick)
 *
 * These tests are written so the engine could be re-implemented in another
 * language from the assertions alone: exact formulas, exact thresholds, and
 * golden integration vectors are baked in. */

// Build an isolated, fully-controlled player to integrate.
// We start from a real game so the player object has every field, then
// overwrite the kinematic + attribute fields we care about. We park every
// OTHER player far away with no target so moveAll's loop over them is inert
// for our assertions (they only decay velocity / clamp, never touch our guy).
function soloPlayer(opts: {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  speed?: number;
  fatigue?: number;
  target?: { x: number; y: number } | null;
}): Player {
  newGame(12345);
  const all = players();
  const p = all[0];
  p.x = opts.x;
  p.y = opts.y;
  p.vx = opts.vx ?? 0;
  p.vy = opts.vy ?? 0;
  p.attr.speed = opts.speed ?? 50;
  p.fatigue = opts.fatigue ?? 0;
  p.target = opts.target === undefined ? null : opts.target;
  // Neutralize everyone else: clear their targets and velocities. They will
  // just sit (decaying ~0 velocity, clamped in-bounds) and never affect p.
  for (let i = 1; i < all.length; i++) {
    all[i].target = null;
    all[i].vx = 0;
    all[i].vy = 0;
  }
  // Detach the ball from any holder so "ball follows holder" tests are explicit.
  G.ball.state = "inbound";
  G.ball.holder = null;
  return p;
}

describe("maxSpeed: (10 + (speed-50)/50*8) * (1 - fatigue*0.18)", () => {
  // The base term is 10 ft/s at speed=50, scaling +/-8 ft/s per 50 speed points
  // away from 50. Fatigue linearly scales the whole thing down by 18% at full.
  function expected(speed: number, fatigue: number): number {
    return (10 + ((speed - 50) / 50) * 8) * (1 - fatigue * 0.18);
  }

  it("speed=50, fatigue=0 -> exactly 10", () => {
    const p = soloPlayer({ x: 10, y: 10, speed: 50, fatigue: 0 });
    expect(maxSpeed(p)).toBe(10);
    expect(maxSpeed(p)).toBe(expected(50, 0));
  });

  it("speed=100, fatigue=0 -> 18 (max attribute adds 8)", () => {
    const p = soloPlayer({ x: 10, y: 10, speed: 100, fatigue: 0 });
    expect(maxSpeed(p)).toBe(18);
    expect(maxSpeed(p)).toBe(expected(100, 0));
  });

  it("speed=0, fatigue=0 -> 2 (min attribute subtracts 8)", () => {
    const p = soloPlayer({ x: 10, y: 10, speed: 0, fatigue: 0 });
    expect(maxSpeed(p)).toBe(2);
    expect(maxSpeed(p)).toBe(expected(0, 0));
  });

  it("speed=75, fatigue=0 -> 14 (linear in speed)", () => {
    const p = soloPlayer({ x: 10, y: 10, speed: 75, fatigue: 0 });
    expect(maxSpeed(p)).toBe(14);
    expect(maxSpeed(p)).toBe(expected(75, 0));
  });

  it("speed=50, fatigue=1 -> 8.2 (full fatigue cuts 18%)", () => {
    const p = soloPlayer({ x: 10, y: 10, speed: 50, fatigue: 1 });
    expect(maxSpeed(p)).toBeCloseTo(8.2, 10);
    expect(maxSpeed(p)).toBeCloseTo(expected(50, 1), 10);
  });

  it("speed=50, fatigue=0.5 -> 9.1 (half fatigue cuts 9%)", () => {
    const p = soloPlayer({ x: 10, y: 10, speed: 50, fatigue: 0.5 });
    expect(maxSpeed(p)).toBeCloseTo(9.1, 10);
    expect(maxSpeed(p)).toBeCloseTo(expected(50, 0.5), 10);
  });

  it("speed=100, fatigue=1 -> 14.76 (both factors compose multiplicatively)", () => {
    const p = soloPlayer({ x: 10, y: 10, speed: 100, fatigue: 1 });
    expect(maxSpeed(p)).toBeCloseTo(14.76, 10);
    expect(maxSpeed(p)).toBeCloseTo(expected(100, 1), 10);
  });
});

describe("moveAll: no target -> velocity decays by *0.7 each tick", () => {
  // When p.target is null the player coasts: vx,vy *= 0.7 per tick, then
  // position integrates by v*DT, then clamped to bounds.
  it("applies 0.7 damping then integrates position", () => {
    seedRng(999);
    const p = soloPlayer({ x: 20, y: 20, vx: 10, vy: -5, target: null });
    moveAll();
    // velocity damped first
    expect(p.vx).toBeCloseTo(7, 10); // 10 * 0.7
    expect(p.vy).toBeCloseTo(-3.5, 10); // -5 * 0.7
    // position integrates with the DAMPED velocity
    expect(p.x).toBeCloseTo(20 + 7 * DT, 10); // 20.7
    expect(p.y).toBeCloseTo(20 + -3.5 * DT, 10); // 19.65
  });

  it("repeated damping is geometric (0.7^n)", () => {
    seedRng(999);
    const p = soloPlayer({ x: 20, y: 20, vx: 10, vy: 0, target: null });
    moveAll();
    moveAll();
    moveAll();
    expect(p.vx).toBeCloseTo(10 * 0.7 * 0.7 * 0.7, 10); // 3.43
  });
});

describe("moveAll: steering toward target (arrive behavior)", () => {
  // With a target, desired velocity points at target at maxSpeed, EXCEPT when
  // within 0.6 ft the desired speed is 0 (arrive/stop). Velocity changes are
  // rate-limited to acc*DT per tick where acc = maxSpeed*4.

  it("accelerates toward target, capped at maxSpeed*4*DT per tick", () => {
    // speed=50 -> ms=10, acc=40, acc*DT=4 ft/s max delta per tick.
    // Starting at rest, first tick along +x: dvx = ms = 10, but clamped to 4.
    seedRng(1);
    const p = soloPlayer({ x: 10, y: 25, vx: 0, vy: 0, speed: 50, fatigue: 0, target: { x: 90, y: 25 } });
    moveAll();
    expect(p.vx).toBeCloseTo(4, 10); // clamp(10 - 0, -4, 4) = 4
    expect(p.vy).toBeCloseTo(0, 10);
    expect(p.x).toBeCloseTo(10 + 4 * DT, 10); // 10.4
    expect(p.y).toBeCloseTo(25, 10);
  });

  it("ramps to maxSpeed then drifts down as fatigue accrues", () => {
    // NOTE: maxSpeed depends on fatigue, and fatigue rises by +0.0006/tick once
    // |v| > 6 ft/s. So after the velocity exceeds 6 the achievable max creeps
    // below the nominal 10. These are exact deterministic values.
    seedRng(1);
    const p = soloPlayer({ x: 10, y: 25, vx: 0, vy: 0, speed: 50, fatigue: 0, target: { x: 90, y: 25 } });
    moveAll();
    expect(p.vx).toBeCloseTo(4, 12); // clamp(10-0,-4,4)=4, fatigue still 0
    moveAll();
    expect(p.vx).toBeCloseTo(8, 12); // +4, now |v|>6 so fatigue -> 0.0006
    moveAll();
    // ms now = 10*(1-0.0006*0.18) = 9.99892, vx clamps up to it
    expect(p.vx).toBeCloseTo(9.99892, 12);
    moveAll();
    expect(p.vx).toBeCloseTo(9.99784, 12); // ms with fatigue 0.0012
    moveAll();
    expect(p.vx).toBeCloseTo(9.99676, 12); // ms with fatigue 0.0018
  });

  it("stops within 0.6 ft of target and parks there (arrive)", () => {
    // Place starting just outside 0.6 with low velocity; once inside 0.6 desired
    // speed becomes 0 so the player decelerates toward and settles near target.
    seedRng(7);
    const p = soloPlayer({ x: 49.7, y: 25, vx: 0, vy: 0, speed: 50, fatigue: 0, target: { x: 50, y: 25 } });
    for (let i = 0; i < 200; i++) moveAll();
    const d = Math.hypot(p.x - 50, p.y - 25);
    expect(d).toBeLessThan(0.6);
    // settled: velocity essentially zero
    expect(Math.abs(p.vx)).toBeLessThan(1e-6);
    expect(Math.abs(p.vy)).toBeLessThan(1e-6);
  });

  it("converges to within 0.6 ft from far away then settles", () => {
    seedRng(7);
    const p = soloPlayer({ x: 5, y: 5, vx: 0, vy: 0, speed: 50, fatigue: 0, target: { x: 80, y: 40 } });
    for (let i = 0; i < 1000; i++) moveAll();
    const d = Math.hypot(p.x - 80, p.y - 40);
    expect(d).toBeLessThan(0.6);
  });

  it("when within 0.6 the desired speed is 0 -> decelerates", () => {
    // Inside the arrive radius with inbound velocity: desv=0 so velocity is
    // pulled toward 0 by acc*DT each tick.
    seedRng(3);
    const p = soloPlayer({ x: 50.2, y: 25, vx: 10, vy: 0, speed: 50, fatigue: 0, target: { x: 50, y: 25 } });
    moveAll();
    // dvx = 0; clamp(0 - 10, -4, 4) = -4 -> vx = 6
    expect(p.vx).toBeCloseTo(6, 10);
  });
});

describe("moveAll: clamp to court bounds [1, COURT_L-1] x [1, COURT_W-1]", () => {
  // Position is clamped to x in [1,93], y in [1,49] every tick.
  it("clamps x to lower bound 1", () => {
    seedRng(5);
    const p = soloPlayer({ x: 1.2, y: 25, vx: -50, vy: 0, target: null });
    moveAll();
    expect(p.x).toBe(1);
  });

  it("clamps x to upper bound COURT_L-1 = 93", () => {
    seedRng(5);
    const p = soloPlayer({ x: 92.8, y: 25, vx: 50, vy: 0, target: null });
    moveAll();
    expect(p.x).toBe(COURT_L - 1);
    expect(p.x).toBe(93);
  });

  it("clamps y to lower bound 1", () => {
    seedRng(5);
    const p = soloPlayer({ x: 25, y: 1.1, vx: 0, vy: -50, target: null });
    moveAll();
    expect(p.y).toBe(1);
  });

  it("clamps y to upper bound COURT_W-1 = 49", () => {
    seedRng(5);
    const p = soloPlayer({ x: 25, y: 48.9, vx: 0, vy: 50, target: null });
    moveAll();
    expect(p.y).toBe(COURT_W - 1);
    expect(p.y).toBe(49);
  });

  it("steering toward an out-of-bounds target still clamps into court", () => {
    seedRng(5);
    const p = soloPlayer({ x: 90, y: 45, vx: 0, vy: 0, speed: 100, target: { x: 200, y: 200 } });
    for (let i = 0; i < 100; i++) moveAll();
    expect(p.x).toBe(93);
    expect(p.y).toBe(49);
  });
});

describe("moveAll: fatigue accrual depends on speed magnitude", () => {
  // After integrating, fatigue += +0.0006 if |v| > 6 ft/s else -0.0004, clamped [0,1].
  it("gains fatigue when moving faster than 6 ft/s", () => {
    seedRng(2);
    const p = soloPlayer({ x: 10, y: 25, vx: 0, vy: 0, speed: 100, fatigue: 0.5, target: { x: 90, y: 25 } });
    // speed=100, fatigue=0.5 -> ms = 18*(1-0.5*0.18) = 18*0.91 = 16.38,
    // acc*DT = ms*4*0.1 = 6.552; first tick vx clamps to 6.552 (>6) so fatigue rises.
    moveAll();
    expect(p.vx).toBeCloseTo(6.552, 12);
    expect(p.fatigue).toBeCloseTo(0.5006, 12);
  });

  it("loses fatigue when moving slower than 6 ft/s (rest)", () => {
    seedRng(2);
    const p = soloPlayer({ x: 10, y: 25, vx: 0, vy: 0, fatigue: 0.5, target: null });
    moveAll();
    expect(p.fatigue).toBeCloseTo(0.4996, 10);
  });

  it("fatigue is clamped to [0,1] (cannot go below 0)", () => {
    seedRng(2);
    const p = soloPlayer({ x: 10, y: 25, vx: 0, vy: 0, fatigue: 0, target: null });
    moveAll();
    expect(p.fatigue).toBe(0);
  });

  it("fatigue boundary: exactly 6 ft/s does NOT accrue (strict >)", () => {
    seedRng(2);
    const p = soloPlayer({ x: 10, y: 25, vx: 6, vy: 0, fatigue: 0.5, target: null });
    // no target -> vx damps to 4.2 first (6*0.7) then integrates; hypot=4.2 < 6
    moveAll();
    expect(p.vx).toBeCloseTo(4.2, 10);
    expect(p.fatigue).toBeCloseTo(0.4996, 10);
  });
});

describe("moveAll: ball follows holder only when state === 'held'", () => {
  it("held ball snaps to holder position each tick", () => {
    seedRng(11);
    const p = soloPlayer({ x: 10, y: 25, vx: 0, vy: 0, speed: 50, target: { x: 90, y: 25 } });
    G.ball.state = "held";
    G.ball.holder = p;
    G.ball.x = 0;
    G.ball.y = 0;
    moveAll();
    expect(G.ball.x).toBe(p.x);
    expect(G.ball.y).toBe(p.y);
    expect(G.ball.x).not.toBe(0);
  });

  it("ball does NOT follow when state is not 'held'", () => {
    seedRng(11);
    const p = soloPlayer({ x: 10, y: 25, vx: 0, vy: 0, speed: 50, target: { x: 90, y: 25 } });
    G.ball.state = "pass";
    G.ball.holder = p;
    G.ball.x = 0;
    G.ball.y = 0;
    moveAll();
    expect(G.ball.x).toBe(0);
    expect(G.ball.y).toBe(0);
  });

  it("ball does NOT follow when holder is null even if state is 'held'", () => {
    seedRng(11);
    soloPlayer({ x: 10, y: 25, target: null });
    G.ball.state = "held";
    G.ball.holder = null;
    G.ball.x = 42;
    G.ball.y = 17;
    moveAll();
    expect(G.ball.x).toBe(42);
    expect(G.ball.y).toBe(17);
  });
});

describe("GOLDEN VECTOR: deterministic single-player integration", () => {
  // A port that implements maxSpeed + moveAll exactly should reproduce these
  // numbers bit-for-bit. seed and starting conditions are fixed; movement is
  // fully deterministic (no RNG inside moveAll), so these are exact constants.
  //
  // Setup: speed=50 (ms=10, acc=40, acc*DT=4), fatigue=0, start (10,25),
  // target (90,25). Pure +x acceleration ramp then constant velocity.
  it("position/velocity trace over 5 ticks", () => {
    seedRng(0);
    const p = soloPlayer({ x: 10, y: 25, vx: 0, vy: 0, speed: 50, fatigue: 0, target: { x: 90, y: 25 } });
    const trace: Array<{ x: number; vx: number }> = [];
    for (let i = 0; i < 5; i++) {
      moveAll();
      trace.push({ x: p.x, vx: p.vx });
    }
    // Velocity ramps +4/tick until it hits maxSpeed; once |v|>6 fatigue grows
    // +0.0006/tick which shaves maxSpeed slightly below 10 from tick 3 on.
    // tick1: vx 0->4,        x 10 -> 10.4              (fatigue 0)
    // tick2: vx 4->8,        x -> 11.2                 (fatigue -> 0.0006)
    // tick3: vx 8->9.99892,  x -> 12.199892           (fatigue -> 0.0012)
    // tick4: vx -> 9.99784,  x -> 13.199676           (fatigue -> 0.0018)
    // tick5: vx -> 9.99676,  x -> 14.199352           (fatigue -> 0.0024)
    const golden = [
      { x: 10.4, vx: 4 },
      { x: 11.200000000000001, vx: 8 },
      { x: 12.199892000000002, vx: 9.99892 },
      { x: 13.199676000000002, vx: 9.99784 },
      { x: 14.199352000000001, vx: 9.99676 },
    ];
    for (let i = 0; i < 5; i++) {
      expect(trace[i].vx).toBeCloseTo(golden[i].vx, 12);
      expect(trace[i].x).toBeCloseTo(golden[i].x, 12);
    }
  });

  it("diagonal target produces equal x/y components (symmetry)", () => {
    seedRng(0);
    const p = soloPlayer({ x: 25, y: 25, vx: 0, vy: 0, speed: 50, fatigue: 0, target: { x: 45, y: 45 } });
    moveAll();
    // dx=dy=20 -> unit (0.7071,0.7071) * ms 10 = desired (7.071,7.071);
    // clamp(7.071,-4,4)=4 each axis.
    expect(p.vx).toBeCloseTo(p.vy, 12);
    expect(p.vx).toBeCloseTo(4, 12);
  });
});
