/*
 * Position/velocity logger for a handful of possessions.
 *
 *   npx tsx scripts/posLog.ts --seed 1 --ticks 120
 *
 * Prints, per tick: ball state/pos/speed and each on-court player's pos, speed,
 * and distance to their target. Used to eyeball movement realism.
 */
import { newGame, G, players } from "../src/core/state.js";
import { tick } from "../src/sim/possession.js";
import { maxSpeed } from "../src/sim/movement.js";

function num(flag: string, def: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

const seed = num("--seed", 1);
const ticks = num("--ticks", 120);

newGame(seed);

function spd(vx: number, vy: number): number {
  return Math.hypot(vx, vy);
}

for (let t = 0; t < ticks; t++) {
  tick();
  const b = G.ball;
  const bspeed = b.bspeed ?? 0;
  const line = [
    `t=${(t * 0.1).toFixed(1)}s`,
    `ball[${b.state}] (${b.x.toFixed(1)},${b.y.toFixed(1)}) bspeed=${(bspeed as number).toFixed(1)}`,
    `off=${G.offense} sc=${G.shotClock.toFixed(1)}`,
  ].join("  ");
  console.log(line);
  const onCourt = players().filter((p) => G.home.indexOf(p) < 5 || G.away.indexOf(p) < 5);
  for (const p of onCourt) {
    const s = spd(p.vx, p.vy);
    const ms = maxSpeed(p);
    const tgt = p.target ? `tgt(${p.target.x.toFixed(1)},${p.target.y.toFixed(1)}) d=${Math.hypot(p.target.x - p.x, p.target.y - p.y).toFixed(1)}` : "tgt:none";
    console.log(
      `   ${p.team[0]}#${p.num} ${p.role.padEnd(10)} ${p.hasBall ? "*BALL*" : "      "} (${p.x.toFixed(1)},${p.y.toFixed(1)}) v=${s.toFixed(1)}/${ms.toFixed(1)} ${tgt}`,
    );
  }
}
