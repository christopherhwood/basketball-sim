import { DT, ARC_R, COURT_L } from "../core/constants.js";
import { dist, clamp, lerp, chance, randn, shotTypeFor, distToSeg } from "../core/math.js";
import { G, offTeam, defTeam, hoop, logEv } from "../core/state.js";
import { tacFor } from "../tactics/tactics.js";
import { threat } from "./defense.js";
import { attemptShot } from "./resolution.js";
import { beginLiveTransition } from "./transition.js";
import { spotsFor } from "./possession.js";
import { nearestDef, makeProb, contestOf } from "./shot.js";
import { tendenciesOf, tendencyFactor } from "./tendency.js";
import type { Player, Point, Tactics } from "../types.js";

/* ---------- TURNOVER / STEAL / SHOT-SELECTION TUNING ----------
   Every magnitude below is a named knob so the tuning phase can adjust the
   stat it drives without hunting through the logic. Probabilities here apply
   once per decision window (offenseDecide runs every decideCD ticks) or once
   per pass, so they are small per-event but accumulate over a possession. */

// On-ball turnovers / strips (moves TOV up, STL up). Applied once per decision window.
const ON_BALL_TOV_BASE = 0.0017; // baseline chance the on-ball defender forces a TO this window
const STRIP_PRESSURE_MULT: Record<Tactics["pressure"], number> = {
  tight: 1.5, // full-court/ball pressure forces more turnovers
  normal: 1.0,
  sag: 0.55, // sagging off invites fewer live-ball turnovers
};
const STRIP_STEAL_SLOPE = 1 / 4200; // per point of (defender steal - handler handle)
const STRIP_IQ_SLOPE = 1 / 7000; // per point of (defender iq deficit relative to handler) — low handler iq -> more TOs
const STRIP_DRIVE_MULT = 1.7; // driving into pressure is far more turnover-prone
const ON_BALL_TOV_CAP = 0.02; // ceiling on per-window forced-turnover probability
const STRIP_CLEAN_SHARE = 0.4; // of forced TOs, this fraction are clean steals (credit STL); rest are lost balls

// Bad-pass / handling turnovers on a pass (moves TOV up, some STL up).
const BAD_PASS_BASE = 0.0042; // baseline errant-pass chance
const BAD_PASS_PASS_SLOPE = 1 / 2400; // per point of (70 - passer pass): worse passers throw it away more
const BAD_PASS_RECV_PRESSURE = 0.011; // extra chance when a defender is hard on the receiver
const BAD_PASS_RECV_RADIUS = 4.5; // a defender within this of the receiver pressures the catch
const BAD_PASS_CLAIM_RADIUS = 4.5; // a defender this close to the errant ball claims it (credit STL)
const BAD_PASS_CAP = 0.03; // ceiling on bad-pass probability
// Whether a recovered errant pass is credited as a STEAL is gated by the
// recovering defender's gambleSteal: gamblers jump the ball (steal), passive
// defenders merely corral the loose ball (turnover, no steal). This routes the
// bad-pass steal channel through gambleSteal so the tendency drives total steals.
const BAD_PASS_STEAL_GAMBLE_PIVOT = 50;
const BAD_PASS_STEAL_GAMBLE_SLOPE = 1 / 90; // per point of (gambleSteal - pivot)
const BAD_PASS_STEAL_BASE = 0.72; // claim->steal chance at neutral gambleSteal

// Passing-lane steal (moves STL up). Modestly raised from the prior values.
const LANE_STEAL_BASE = 0.0125; // was 0.015
const LANE_STEAL_STEAL_SLOPE = 1 / 1600; // per point of (defender steal - 70); was 1/600
const LANE_STEAL_PASS_SLOPE = 1 / 2400; // per point of (passer pass - 70) — reduces the chance
const LANE_STEAL_CAP = 0.018; // was 0.06

// Three-point shot volume (moves 3PA without flattening per-player divergence).
const THREE_UTILITY_MULT = 0.85; // scales three-shoot utility; high-shootThree still out-shoots low
// Compress how strongly the shootThree tendency swings three volume: 1 = full
// (0.5..1.5) swing, lower values pull both extremes toward neutral so low-three
// teams clear the floor (>=28) while high-three teams stay under the ceiling.
const THREE_TEND_COMPRESS = 0.62;
// Flat additive bump to open three-point utility. Lifts low-three teams toward
// the 3PA floor WITHOUT scaling up high-volume teams (they are already shooting),
// so it tightens the floor without pushing the pace-and-space ceiling over.
const THREE_UTILITY_FLOOR = 1.85;

/* ---------- 4) OFFENSE AI ---------- */
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

    // ----- on-ball turnover / strip check (before any shoot/drive/pass) -----
    // The on-ball defender can force a live-ball turnover this window. Scales with
    // defensive pressure, the defender's steal+gambleSteal vs the handler's
    // handle+iq, and whether the handler is driving into the defense.
    {
      const onBallDef = def.find((d) => d.assign === bh) || nearestDef(bh, def).d;
      if (onBallDef) {
        const stealEdge = (onBallDef.attr.steal - bh.attr.handle) * STRIP_STEAL_SLOPE;
        const iqEdge = (onBallDef.attr.iq - bh.attr.iq) * STRIP_IQ_SLOPE;
        let tovP =
          (ON_BALL_TOV_BASE + Math.max(0, stealEdge) + Math.max(0, iqEdge)) *
          STRIP_PRESSURE_MULT[tac.pressure] *
          tendencyFactor(tendenciesOf(onBallDef).gambleSteal);
        if (G.driving) tovP *= STRIP_DRIVE_MULT;
        tovP = clamp(tovP, 0, ON_BALL_TOV_CAP);
        if (chance(tovP)) {
          bh.stats.tov++;
          if (chance(STRIP_CLEAN_SHARE)) {
            // clean steal: the on-ball defender takes it and pushes the other way
            onBallDef.stats.stl++;
            logEv(`${onBallDef.name} strips ${bh.name} — steal!`, "to");
            G.driving = false;
            beginLiveTransition(onBallDef);
          } else {
            // lost ball / bad handle: nearest defender recovers (no STL credited)
            const recover = nearestDef(bh, def).d || onBallDef;
            logEv(`${bh.name} loses the handle — turnover`, "to");
            G.driving = false;
            beginLiveTransition(recover);
          }
          return;
        }
      }
    }

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
      if (type === "three") return s === "three" ? 1.4 : s === "rim" ? 0.55 : 1;
      if (type === "rim" || type === "close") return s === "rim" ? 1.4 : s === "three" ? 0.7 : 1;
      return s === "three" ? 0.7 : 1;
    })();
    // urgency as shot clock winds down
    const urg = G.shotClock < 10 ? (10 - G.shotClock) / 10 : 0;

    // zone-specific shooting tendency (driveRim doubles as rim-shooting propensity).
    // postUp has no mechanic yet and is intentionally left unwired.
    const tendencies = tendenciesOf(bh);
    const shootTend =
      type === "three" ? tendencies.shootThree : type === "mid" ? tendencies.shootMid : tendencies.driveRim;
    let shootU = ev * selM * (0.35 + 0.65 * open) + urg * 2.4;
    if (type === "three") {
      // compressed tendency swing keeps the high/low ordering but narrows the
      // absolute spread, then THREE_UTILITY_MULT sets the overall volume.
      const tf = 1 + (tendencyFactor(shootTend) - 1) * THREE_TEND_COMPRESS;
      shootU *= tf * THREE_UTILITY_MULT;
      // open-look floor: nudges MILDLY-reluctant but capable shooters to take the
      // open three. The reluctance weight is a band peaking around shootThree ~50
      // and fading to zero both at neutral-plus (high-volume teams already shoot
      // plenty) AND at the very-low extreme (a team that truly never shoots threes
      // must stay low, so per-player divergence is preserved at the extremes).
      const reluctance = clamp((shootTend - 26) / 18, 0, 1) * clamp((64 - shootTend) / 13, 0, 1);
      // capability band peaks for solid-but-not-elite shooters (three ~55-68) and
      // fades for both non-shooters (would tank 3P%) and elite high-volume shooters
      // (already shooting plenty — keeps pace-and-space teams under the ceiling).
      const t3 = bh.attr.three;
      const capable = clamp((t3 - 42) / 16, 0, 1) * clamp((78 - t3) / 16, 0, 1);
      shootU += THREE_UTILITY_FLOOR * open * reluctance * capable;
    } else {
      shootU *= tendencyFactor(shootTend);
    }

    // drive utility: open lane + handle vs man, value of getting to rim
    const onBall = def.find((d) => d.assign === bh) || nearestDef(bh, def).d;
    const laneBlock = rimHelp(bh, def, h);
    let driveU =
      (dh > 6 ? clamp((bh.attr.handle - (onBall ? onBall.attr.perimD : 50)) / 40, -0.3, 0.6) + 0.45 : -1) *
      (1 - laneBlock * 0.7);
    if (tac.shotSel === "rim") driveU += 0.25;
    if (tac.shotSel === "three") driveU -= 0.2;
    driveU *= tendencyFactor(tendencies.driveRim);

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
    let passU = (bestPU + passBias) * tendencyFactor(tendencies.pass);

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

function rimHelp(bh: Player, def: Player[], h: Point): number {
  // how protected is the rim right now (0..1)
  let v = 0;
  for (const d of def) {
    if (dist(d, h) < 7) v += clamp((d.attr.interiorD + d.attr.block) / 200, 0, 0.6);
  }
  return clamp(v, 0, 1);
}

/* primary action: pick & roll or motion, plus off-ball movement for everyone. */
function runAction(off: Player[], def: Player[], h: Point, tac: Tactics): void {
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
    // pick the eligible big with the highest screen tendency; fall back to role/off[4]
    let screener = off.find((p) => p.role === "screener") || off[4];
    let bestScreen = -1;
    for (const p of off) {
      if (p === bh) continue;
      const sc = tendenciesOf(p).screen;
      if (sc > bestScreen) {
        bestScreen = sc;
        screener = p;
      }
    }
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
      const pops = screener.attr.three > 74 || tendenciesOf(screener).shootThree > 74;
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
function offBallMove(off: Player[], def: Player[], h: Point, dir: number, tac: Tactics): void {
  const bh = G.ball.holder;
  if (!bh) return;
  const spots = spotsFor(G.attackHoop);
  const driving = G.driving && dist(bh, h) < 20;
  const driveLow = bh.y < 25;
  // index defenders by their assignment once (first match wins, matching find())
  const defByAssign = new Map<Player, Player>();
  for (const x of def) if (x.assign && !defByAssign.has(x.assign)) defByAssign.set(x.assign, x);
  for (const p of off) {
    if (p === bh) continue;
    if (tac.action === "pnr" && p.role === "screener") continue; // screener owned by pnr logic
    const ob = p.ob;
    if (!ob) continue;
    ob.t += DT;
    const d = defByAssign.get(p);
    const cutFactor = tendencyFactor(tendenciesOf(p).driveRim);
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
      if (d && dist(d, p) < 3.0 && dist(d, h) > dist(p, h) - 1 && threat(p) > 0.45 && chance(0.05 * cutFactor)) {
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
      if (chance(0.01 * cutFactor)) {
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

function mostOpenSpot(p: Player, spots: Point[], off: Player[], def: Player[]): Point {
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

function startPass(from: Player, to: Player): void {
  from.hasBall = false;
  G.ball.state = "pass";
  G.ball.holder = null;
  G.ball.target = to;
  G.ball.flight = 0;
  G.ball.from = from;
  G.ball.passDur = Math.max(2, (dist(from, to) * 0.6) | 0);
  const def = defTeam();

  // bad-pass / handling turnover: the pass itself is errant or deflected.
  // Scales with the passer's (low) pass attribute and with defensive pressure
  // on the receiver. On a turnover the ball goes to the nearest recovering
  // defender; if a defender is close enough to the errant ball, credit a steal.
  {
    let recvPressure = 0;
    for (const d of def) {
      if (dist(d, to) < BAD_PASS_RECV_RADIUS) recvPressure = BAD_PASS_RECV_PRESSURE;
    }
    const badP = clamp(
      BAD_PASS_BASE + Math.max(0, (70 - from.attr.pass) * BAD_PASS_PASS_SLOPE) + recvPressure,
      0,
      BAD_PASS_CAP,
    );
    if (chance(badP)) {
      from.stats.tov++;
      // nearest defender to the intended target recovers the loose ball
      let recover: Player | null = null,
        rd = 1e9;
      for (const d of def) {
        const dd = dist(d, to);
        if (dd < rd) {
          rd = dd;
          recover = d;
        }
      }
      if (recover && rd < BAD_PASS_CLAIM_RADIUS) {
        const stealChance = clamp(
          BAD_PASS_STEAL_BASE +
            (tendenciesOf(recover).gambleSteal - BAD_PASS_STEAL_GAMBLE_PIVOT) * BAD_PASS_STEAL_GAMBLE_SLOPE,
          0,
          1,
        );
        if (chance(stealChance)) {
          recover.stats.stl++;
          logEv(`${recover.name} picks off the pass — steal!`, "to");
        } else {
          logEv(`${from.name} throws it away — turnover`, "to");
        }
      } else {
        logEv(`${from.name} throws it away — turnover`, "to");
      }
      if (recover) beginLiveTransition(recover);
      return;
    }
  }

  // passing-lane steal: only a defender genuinely sitting in the passing lane,
  // not near either endpoint (that would be normal on-ball/catch defense).
  for (const d of def) {
    const ld = distToSeg(d, from, to);
    if (ld < 2.0 && dist(d, from) > 4 && dist(d, to) > 4) {
      const sp =
        clamp(
          LANE_STEAL_BASE + (d.attr.steal - 70) * LANE_STEAL_STEAL_SLOPE - (from.attr.pass - 70) * LANE_STEAL_PASS_SLOPE,
          0,
          LANE_STEAL_CAP,
        ) * tendencyFactor(tendenciesOf(d).gambleSteal);
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
