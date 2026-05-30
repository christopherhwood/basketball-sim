/**
 * Cadence check: measure off-ball movement statistics for one offensive
 * possession (seed 42) and report re-targets/player/sec and stationary%.
 */
import { seedRng } from "../src/core/rng.js";
import { newGame, G, players } from "../src/core/state.js";
import { tick } from "../src/sim/possession.js";
import type { Player } from "../src/types.js";

const DT = 0.1;

seedRng(42);
newGame(42);
G.homeAttack = "R";
G.awayAttack = "L";
G.attackHoop = "R";

// Track per-player stats
type PlayerTrace = {
  prevTarget: { x: number; y: number } | null;
  retargets: number;
  stationaryTicks: number;
  totalTicks: number;
  totalDist: number;
  prevPos: { x: number; y: number };
};

const traces = new Map<Player, PlayerTrace>();
const offTeamSide = G.offense;

// Initialize for the 5 offensive players
for (const p of (offTeamSide === "home" ? G.home : G.away)) {
  traces.set(p, {
    prevTarget: p.target ? { ...p.target } : null,
    retargets: 0,
    stationaryTicks: 0,
    totalTicks: 0,
    totalDist: 0,
    prevPos: { x: p.x, y: p.y },
  });
}

let initialOffense = G.offense;
let possessionTick = 0;

// Run until possession changes
for (let i = 0; i < 5000; i++) {
  // Before tick: record current positions and targets
  const offPlayers = offTeamSide === "home" ? G.home : G.away;
  const preStates = new Map<Player, { x: number; y: number; tx: number | null; ty: number | null }>();
  for (const p of offPlayers) {
    preStates.set(p, { x: p.x, y: p.y, tx: p.target?.x ?? null, ty: p.target?.y ?? null });
  }

  tick();
  possessionTick++;

  // Check if possession changed
  if (G.offense !== initialOffense) {
    break;
  }

  // After tick: measure
  const bh = G.ball.holder;
  for (const p of offPlayers) {
    if (p === bh) continue; // skip ball handler
    const trace = traces.get(p);
    if (!trace) continue;
    const pre = preStates.get(p)!;

    trace.totalTicks++;

    // Distance traveled this tick
    const dx = p.x - pre.x;
    const dy = p.y - pre.y;
    const d = Math.hypot(dx, dy);
    trace.totalDist += d;

    // Stationary: speed < 1 ft/s (0.1 ft per 0.1s tick)
    const speed = d / DT; // ft/s
    if (speed < 1.0) trace.stationaryTicks++;

    // Re-target: did target change?
    if (p.target && pre.tx !== null && pre.ty !== null) {
      if (Math.abs(p.target.x - pre.tx) > 0.01 || Math.abs(p.target.y - pre.ty) > 0.01) {
        trace.retargets++;
      }
    } else if (p.target && (pre.tx === null || pre.ty === null)) {
      trace.retargets++;
    }
  }
}

const totalTimeSec = possessionTick * DT;
console.log(`\nPossession length: ${totalTimeSec.toFixed(1)}s (${possessionTick} ticks)\n`);
console.log("Player off-ball cadence stats:");
console.log("─".repeat(70));
console.log("Player".padEnd(12), "Dist(ft)".padStart(9), "Retargets".padStart(10), "RT/sec".padStart(8), "Stat%".padStart(8));
console.log("─".repeat(70));

let totalRetargetsPerSec = 0;
let totalStationaryPct = 0;
let count = 0;

const offPlayers = offTeamSide === "home" ? G.home : G.away;
for (const p of offPlayers) {
  if (p === G.ball.holder) continue;
  const trace = traces.get(p);
  if (!trace || trace.totalTicks === 0) continue;

  const timeSec = trace.totalTicks * DT;
  const rtPerSec = trace.retargets / timeSec;
  const statPct = (trace.stationaryTicks / trace.totalTicks) * 100;

  console.log(
    p.name.substring(0, 12).padEnd(12),
    trace.totalDist.toFixed(1).padStart(9),
    trace.retargets.toString().padStart(10),
    rtPerSec.toFixed(3).padStart(8),
    statPct.toFixed(1).padStart(7) + "%"
  );

  totalRetargetsPerSec += rtPerSec;
  totalStationaryPct += statPct;
  count++;
}

console.log("─".repeat(70));
console.log(
  "AVG".padEnd(12),
  "".padStart(9),
  "".padStart(10),
  (totalRetargetsPerSec / count).toFixed(3).padStart(8),
  (totalStationaryPct / count).toFixed(1).padStart(7) + "%"
);
console.log("\nTargets: re-targets/player/sec (NBA real ~0.2-0.3); stationary% (NBA real ~45-55%)");
