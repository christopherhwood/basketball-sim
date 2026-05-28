import { clamp, dist, lerp, distToSeg, shotTypeFor } from "../src/core/math.js";
import { ARC_R, COURT_L, COURT_W, HOOP, DT } from "../src/core/constants.js";

// These tests pin down the pure geometry helpers in src/core/math.ts and the
// court constants in src/core/constants.ts. They are written so the engine can
// be re-implemented in another language from the formulas/thresholds alone.

describe("constants: court dimensions and hoop geometry", () => {
  // A regulation half-court layout used throughout the sim. All distances are in
  // feet. These exact values are load-bearing for shotTypeFor and positioning.
  it("court is 94ft long by 50ft wide", () => {
    expect(COURT_L).toBe(94);
    expect(COURT_W).toBe(50);
  });

  it("three-point arc radius is 23.75ft", () => {
    expect(ARC_R).toBe(23.75);
  });

  it("simulation timestep DT is 0.1s", () => {
    expect(DT).toBe(0.1);
  });

  it("hoops sit 5.25ft from each baseline, centered at y=25 (half of width)", () => {
    expect(HOOP.L).toEqual({ x: 5.25, y: 25 });
    expect(HOOP.R).toEqual({ x: 88.75, y: 25 });
    // R hoop mirrors L across mid-court: COURT_L - L.x === R.x
    expect(COURT_L - HOOP.L.x).toBe(HOOP.R.x);
    // both hoops centered on the width axis
    expect(HOOP.L.y).toBe(COURT_W / 2);
    expect(HOOP.R.y).toBe(COURT_W / 2);
  });
});

describe("clamp(v, a, b): bound v into [a, b]", () => {
  // clamp returns a if v<a, b if v>b, else v unchanged.
  it("returns v when inside the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("returns the lower bound a when v < a", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });
  it("returns the upper bound b when v > b", () => {
    expect(clamp(42, 0, 10)).toBe(10);
  });
  it("is inclusive at both endpoints", () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
  it("works with negative and fractional ranges", () => {
    expect(clamp(-0.5, -1, 1)).toBe(-0.5);
    expect(clamp(-5, -1, 1)).toBe(-1);
    expect(clamp(2.5, -1, 1)).toBe(1);
  });
});

describe("lerp(a, b, t): linear interpolation a + (b-a)*t", () => {
  it("t=0 returns a, t=1 returns b", () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
  });
  it("t=0.5 returns the midpoint", () => {
    expect(lerp(10, 20, 0.5)).toBe(15);
  });
  it("extrapolates for t outside [0,1]", () => {
    expect(lerp(0, 10, 2)).toBe(20);
    expect(lerp(0, 10, -1)).toBe(-10);
  });
  it("handles a descending range", () => {
    expect(lerp(100, 0, 0.25)).toBe(75);
  });
});

describe("dist(a, b): Euclidean distance hypot(ax-bx, ay-by)", () => {
  it("classic 3-4-5 right triangle", () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
  it("zero distance for identical points", () => {
    expect(dist({ x: 7, y: 7 }, { x: 7, y: 7 })).toBe(0);
  });
  it("is symmetric and axis-aligned distances are exact", () => {
    expect(dist({ x: 1, y: 2 }, { x: 4, y: 2 })).toBe(3);
    expect(dist({ x: 4, y: 2 }, { x: 1, y: 2 })).toBe(3);
    expect(dist({ x: 0, y: 0 }, { x: 0, y: -9 })).toBe(9);
  });
  it("diagonal distance: unit square diagonal is sqrt(2)", () => {
    expect(dist({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(Math.SQRT2, 12);
  });
});

describe("distToSeg(p, a, b): distance from point p to segment AB", () => {
  // Algorithm: project w=(p-a) onto v=(b-a). Let c1 = v.w.
  //  - if c1 <= 0, p projects before A -> return dist(p, a)
  //  - if v.v <= c1, p projects after B -> return dist(p, b)
  //  - else interior: t = c1/(v.v), return dist(p, a + t*v)
  // Use a horizontal segment A=(0,0)..B=(10,0) so cases are easy to reason about.
  const A = { x: 0, y: 0 };
  const B = { x: 10, y: 0 };

  it("case 1: point projects BEFORE A -> distance to endpoint A", () => {
    // p is up-and-to-the-left of A; nearest point on the segment is A itself.
    const p = { x: -3, y: 4 };
    expect(distToSeg(p, A, B)).toBe(5); // dist(p, A) = hypot(3,4)
  });

  it("case 2: point projects AFTER B -> distance to endpoint B", () => {
    // p is up-and-to-the-right of B; nearest point on the segment is B itself.
    const p = { x: 13, y: 4 };
    expect(distToSeg(p, A, B)).toBe(5); // dist(p, B) = hypot(3,4)
  });

  it("case 3: point projects ONTO the interior -> perpendicular distance", () => {
    // p sits directly above the midpoint; nearest point is the foot of the
    // perpendicular at (5,0), giving the vertical offset.
    const p = { x: 5, y: 7 };
    expect(distToSeg(p, A, B)).toBe(7);
  });

  it("interior projection at an arbitrary t computes foot-of-perpendicular distance", () => {
    // p=(2,3): projects to (2,0) on the segment, perpendicular distance 3.
    const p = { x: 2, y: 3 };
    expect(distToSeg(p, A, B)).toBe(3);
  });

  it("a point exactly on the segment has zero distance", () => {
    expect(distToSeg({ x: 4, y: 0 }, A, B)).toBe(0);
  });
});

describe("shotTypeFor(d): classify a shot by distance d (feet) to the hoop", () => {
  // Boundary table with ARC_R = 23.75 (so the three threshold is ARC_R-0.5 = 23.25):
  //   d <= 4            -> "rim"
  //   4 < d <= 8        -> "close"
  //   d >= ARC_R-0.5    -> "three"   (i.e. d >= 23.25)
  //   otherwise         -> "mid"     (8 < d < 23.25)
  // Note: the three check is evaluated before the mid fallthrough.
  it("the three threshold equals ARC_R - 0.5 = 23.25", () => {
    expect(ARC_R - 0.5).toBe(23.25);
  });

  it("d <= 4 is a rim shot", () => {
    expect(shotTypeFor(0)).toBe("rim");
    expect(shotTypeFor(4)).toBe("rim"); // inclusive boundary
  });

  it("4 < d <= 8 is a close shot", () => {
    expect(shotTypeFor(4.01)).toBe("close"); // just past the rim boundary
    expect(shotTypeFor(8)).toBe("close"); // inclusive boundary
  });

  it("8 < d < 23.25 is a mid-range shot", () => {
    expect(shotTypeFor(8.01)).toBe("mid"); // just past the close boundary
    expect(shotTypeFor(15)).toBe("mid"); // well inside mid-range
    expect(shotTypeFor(23.24)).toBe("mid"); // just under the three boundary
  });

  it("d >= 23.25 is a three", () => {
    expect(shotTypeFor(23.25)).toBe("three"); // inclusive boundary (ARC_R-0.5)
    expect(shotTypeFor(30)).toBe("three"); // deep three
  });

  it("exact boundary table (4, 4.01, 8, 8.01, 23.24, 23.25)", () => {
    expect(shotTypeFor(4)).toBe("rim");
    expect(shotTypeFor(4.01)).toBe("close");
    expect(shotTypeFor(8)).toBe("close");
    expect(shotTypeFor(8.01)).toBe("mid");
    expect(shotTypeFor(23.24)).toBe("mid");
    expect(shotTypeFor(23.25)).toBe("three");
  });
});
