import { DT, ARC_R, COURT_L } from "../core/constants.js";
import { dist, clamp, lerp, chance, randn, shotTypeFor, distToSeg } from "../core/math.js";
import { G, offTeam, defTeam, hoop, logEv } from "../core/state.js";
import { tacFor } from "../tactics/tactics.js";
import { threat } from "./defense.js";
import { attemptShot } from "./resolution.js";
import { beginLiveTransition } from "./transition.js";
import { spotsFor } from "./possession.js";
import type { Player, Point, ShotType, Tactics } from "../types.js";

/* ---------- 4) OFFENSE AI ---------- */
export function nearestDef(p: Player, def: Player[]): { d: Player | null; dd: number } {
  let best: Player | null = null,
    bd = 1e9;
  for (const d of def) {
    const dd = dist(p, d);
    if (dd < bd) {
      bd = dd;
      best = d;
    }
  }
  return { d: best, dd: bd };
}

export function makeProb(shooter: Player, type: ShotType, contest: number): number {
  const base = { rim: 0.68, close: 0.5, mid: 0.44, three: 0.372 }[type];
  const sk =
    type === "rim" || type === "close"
      ? shooter.attr.finishing
      : type === "mid"
        ? shooter.attr.mid
        : shooter.attr.three;
  let p = base + ((sk - 55) / 55) * 0.24; // shooting skill
  const cpen = type === "rim" ? 0.15 : type === "three" ? 0.21 : 0.25;
  p -= contest * cpen; // defender contest
  p -= shooter.fatigue * 0.05;
  return clamp(p, 0.02, 0.97);
}

export function contestOf(shooter: Player, def: Player[]): number {
  const { d, dd } = nearestDef(shooter, def);
  const prox = clamp(1 - dd / 9, 0, 1); // no real contest past ~9 ft
  const skill = clamp((d ? d.attr.perimD : 50) / 95, 0, 1.05);
  return clamp(prox * skill, 0, 1);
}

export function offenseDecide(): void {
  const off = offTeam(),
    def = defTeam(),
    h = hoop(),
    tac = tacFor(G.offense);
  // ----- run primary action so possessions have shape -----
  runAction(off, def, h, tac);

  // ----- ball-handler decision (every decideCD ticks) -----
  if (G.decideCD > 0) {
    G.decideCD--;
  } else {
    G.decideCD = 4; // decide ~ every 0.4s
    const bh = G.ball.holder;
    if (!bh) return;
    const dh = dist(bh, h),
      type = shotTypeFor(dh);
    const contest = contestOf(bh, def);
    const open = clamp(1 - contest, 0, 1);
    const pts = type === "three" ? 3 : 2;
    const mp = makeProb(bh, type, contest);
    const ev = mp * pts;

    // shot-selection multiplier from your tactics
    const selM = (() => {
      const s = tac.shotSel;
      if (type === "three") return s === "three" ? 1.5 : s === "rim" ? 0.55 : 1;
      if (type === "rim" || type === "close") return s === "rim" ? 1.4 : s === "three" ? 0.7 : 1;
      return s === "three" ? 0.7 : 1;
    })();
    // urgency as shot clock winds down
    const urg = G.shotClock < 10 ? (10 - G.shotClock) / 10 : 0;

    let shootU = ev * selM * (0.35 + 0.65 * open) + urg * 2.4;
    shootU *= 0.7 + bh.attr.tendShoot * 0.6;

    // drive utility: open lane + handle vs man, value of getting to rim
    const onBall = def.find((d) => d.assign === bh) || nearestDef(bh, def).d;
    const laneBlock = rimHelp(bh, def, h);
    let driveU =
      (dh > 6 ? clamp((bh.attr.handle - (onBall ? onBall.attr.perimD : 50)) / 40, -0.3, 0.6) + 0.45 : -1) *
      (1 - laneBlock * 0.7);
    if (tac.shotSel === "rim") driveU += 0.25;
    if (tac.shotSel === "three") driveU -= 0.2;

    // pass utility: find best teammate (more open / better look)
    let bestPass: Player | null = null,
      bestPU = -1;
    for (const t of off) {
      if (t === bh) continue;
      const tc = contestOf(t, def),
        to = 1 - tc;
      const td = dist(t, h),
        tt = shotTypeFor(td);
      const tev = makeProb(t, tt, tc) * (tt === "three" ? 3 : 2);
      const advance = dist(t, h) < dh - 2 ? 0.3 : 0; // reward feeding closer looks
      const pu = to * 0.9 + tev * 0.5 + advance;
      if (pu > bestPU) {
        bestPU = pu;
        bestPass = t;
      }
    }
    // ball-movement bias early in clock so it isn't iso every time
    const passBias = G.possClock < 6 ? 0.5 : 0.1;
    let passU = bestPU + passBias;

    // low IQ adds noise to the choice
    const noise = ((99 - bh.attr.iq) / 99) * 0.6;
    shootU += randn() * noise;
    driveU += randn() * noise;
    passU += randn() * noise;

    const best = Math.max(shootU, driveU, passU);
    if (best === shootU && (open > 0.2 || G.shotClock < 8 || dh < 6)) {
      G.driving = false;
      attemptShot(bh, type, contest, pts, mp);
    } else if (best === driveU) {
      G.driving = true;
      bh.target = { x: lerp(bh.x, h.x, 0.5), y: lerp(bh.y, h.y, 0.4) };
    } else if (bestPass) {
      G.driving = false;
      startPass(bh, bestPass);
    } else {
      G.driving = false;
      attemptShot(bh, type, contest, pts, mp);
    } // nothing better, just shoot
  }
}

export function rimHelp(bh: Player, def: Player[], h: Point): number {
  // how protected is the rim right now (0..1)
  let v = 0;
  for (const d of def) {
    if (dist(d, h) < 7) v += clamp((d.attr.interiorD + d.attr.block) / 200, 0, 0.6);
  }
  return clamp(v, 0, 1);
}

/* primary action: pick & roll or motion, plus off-ball movement for everyone. */
export function runAction(off: Player[], def: Player[], h: Point, tac: Tactics): void {
  const dir = G.attackHoop === "R" ? -1 : 1;
  G.actionT += DT;
  const sp0 = spotsFor(G.attackHoop);
  const bh = G.ball.holder;
  // while the ball is in flight (pass or shot) nobody has it: just hold spacing
  if (!bh) {
    off.forEach((p, i) => (p.target = sp0[i]));
    return;
  }

  if (tac.action === "pnr") {
    const screener = off.find((p) => p.role === "screener") || off[4];
    if (G.actionPhase === "bringup") {
      bh.target = { x: h.x + dir * 21, y: 25 };
      screener.target = { x: h.x + dir * 11, y: 32 };
      if (G.possClock > 1.6) {
        G.actionPhase = "screen";
      }
    } else if (G.actionPhase === "screen") {
      screener.target = { x: bh.x + dir * 1.5, y: bh.y - 5 };
      G.screen = { ball: bh, screener };
      if (dist(screener, bh) < 5 && G.possClock > 2.6) {
        G.actionPhase = "roll";
      }
    } else if (G.actionPhase === "roll") {
      const pops = screener.attr.three > 74;
      screener.target = pops ? { x: h.x + dir * 22, y: 30 } : { x: h.x + dir * 4, y: 25 };
      G.screen = { ball: bh, screener };
    }
  } else {
    G.screen = null;
  }

  // off-ball movement for all non-handler players (the pnr screener is handled above)
  offBallMove(off, def, h, dir, tac);
}

/* Off-ball movement: relocation to open space, lane-clearing on drives,
   basket cuts with refill, and backdoor cuts against tight ball-side denial.
   This is what generates open looks against disciplined help defense. */
export function offBallMove(off: Player[], def: Player[], h: Point, dir: number, tac: Tactics): void {
  const bh = G.ball.holder;
  if (!bh) return;
  const spots = spotsFor(G.attackHoop);
  const driving = G.driving && dist(bh, h) < 20;
  const driveLow = bh.y < 25;
  for (const p of off) {
    if (p === bh) continue;
    if (tac.action === "pnr" && p.role === "screener") continue; // screener owned by pnr logic
    const ob = p.ob;
    if (!ob) continue;
    ob.t += DT;
    const d = def.find((x) => x.assign === p);
    const shooterBig = threat(p) < 0.34;
    let home = spots[ob.spot] || spots[1];
    if (shooterBig) home = { x: h.x + dir * 4.5, y: ob.spot % 2 ? 17.5 : 32.5 }; // non-shooters play near the rim

    // --- cut in progress ---
    if (ob.state === "cut") {
      p.target = { x: h.x + dir * 2.5, y: ob.cutY as number };
      if (dist(p, { x: h.x, y: 25 }) < 5.5 || ob.t > 2.0) {
        ob.state = "fill";
        ob.t = 0;
        ob.fill = mostOpenSpot(p, spots, off, def);
      }
      continue;
    }
    if (ob.state === "fill") {
      p.target = ob.fill || home;
      if (dist(p, ob.fill || home) < 3 || ob.t > 2.6) {
        ob.state = "space";
        ob.t = 0;
      }
      continue;
    }

    // --- spacing read ---
    let tgt: Point = { x: home.x, y: home.y };
    if (driving) {
      // clear the strong side: if I'm on the drive side, relocate to the weak side
      // (this both opens the lane and sets up the kick-out)
      const onDriveSide = p.y < 25 === driveLow;
      if (onDriveSide && dist(p, h) < 19) tgt = { x: home.x, y: 50 - home.y };
    } else {
      // backdoor vs tight ball-side denial
      if (d && dist(d, p) < 3.0 && dist(d, h) > dist(p, h) - 1 && threat(p) > 0.45 && chance(0.05)) {
        ob.state = "cut";
        ob.t = 0;
        ob.cutY = p.y < 25 ? 20 : 30;
        continue;
      }
      // relocate into open space: slide a few feet away from my own defender
      if (d && dist(d, p) < 7) {
        const away = Math.sign(p.y - d.y) || 1;
        tgt = { x: home.x, y: clamp(home.y + away * 3.5, 3, 47) };
      }
      // occasional basket cut keeps the defense honest
      if (chance(0.01)) {
        ob.state = "cut";
        ob.t = 0;
        ob.cutY = p.y < 25 ? 19 : 31;
        continue;
      }
    }
    // maintain spacing from the nearest teammate
    let nt: Player | null = null,
      nd = 1e9;
    for (const o of off) {
      if (o === p || o === bh) continue;
      const dd = dist(o, p);
      if (dd < nd) {
        nd = dd;
        nt = o;
      }
    }
    if (nt && nd < 8) {
      const ax = p.x - nt.x,
        ay = p.y - nt.y,
        m = Math.hypot(ax, ay) || 1;
      tgt.x += (ax / m) * 2;
      tgt.y += (ay / m) * 2;
    }
    p.target = { x: clamp(tgt.x, 3, COURT_L - 3), y: clamp(tgt.y, 3, 47) };
  }
}

export function mostOpenSpot(p: Player, spots: Point[], off: Player[], def: Player[]): Point {
  let best = spots[3],
    bs = -1e9;
  for (const s of spots) {
    let nd = 1e9;
    for (const d of def) nd = Math.min(nd, dist(d, s));
    let occ = false;
    for (const o of off) {
      if (o !== p && dist(o, s) < 4) occ = true;
    }
    const score = nd - (occ ? 20 : 0);
    if (score > bs) {
      bs = score;
      best = s;
    }
  }
  return best;
}

export function startPass(from: Player, to: Player): void {
  from.hasBall = false;
  G.ball.state = "pass";
  G.ball.holder = null;
  G.ball.target = to;
  G.ball.flight = 0;
  G.ball.from = from;
  G.ball.passDur = Math.max(2, (dist(from, to) * 0.6) | 0);
  // steal check: only a defender genuinely sitting in the passing lane,
  // not near either endpoint (that would be normal on-ball/catch defense).
  const def = defTeam();
  for (const d of def) {
    const ld = distToSeg(d, from, to);
    if (ld < 2.0 && dist(d, from) > 4 && dist(d, to) > 4) {
      const sp = clamp(0.015 + (d.attr.steal - 70) / 600 - (from.attr.pass - 70) / 800, 0, 0.06);
      if (chance(sp)) {
        d.stats.stl++;
        from.stats.tov++;
        logEv(`${d.name} jumps the passing lane — steal!`, "to");
        beginLiveTransition(d);
        return;
      }
    }
  }
}
