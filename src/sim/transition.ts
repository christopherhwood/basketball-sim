import { HOOP, DT } from "../core/constants.js";
import { dist, lerp, clamp, chance } from "../core/math.js";
import { G, offTeam, defTeam, hoop, players, logEv } from "../core/state.js";
import { spotsFor } from "./possession.js";
import { contestOf, makeProb } from "./shot.js";
import { attemptShot } from "./resolution.js";
import { effectiveTendencies } from "./tendency.js";
import { recordFastBreak, recordTransitionStart } from "./debugTally.js";
import type { Player, Point } from "../types.js";

const STEAL_REACTION_DELAY = 0.35;
// Controlled bring-up: even when there's no fast break, walking the ball up and
// surveying the defense takes a beat. The half-court set won't start until at
// least this many seconds have elapsed (a guard reaches the top in ~1.5s at full
// speed, then reads the floor), so possessions don't start their offense the
// instant the ball crosses half court. Keeps pace realistic (~3-4s to initiate).
const BRINGUP_MIN_T = 3.4;
const FASTBREAK_RECOVERY_BASE = 0.16;
const FASTBREAK_RECOVERY_SPEED_SLOPE = 0.012;
const FASTBREAK_RECOVERY_DEF_SLOPE = 0.06;
const FASTBREAK_RECOVERY_MIN = -0.08;
const FASTBREAK_RECOVERY_MAX = 0.34;

// ----- Fast-break gating (floor balance) -----
// A live recovery only becomes a numbers break when the opponent over-committed
// (crashed the glass) or got caught moving the wrong way (a live steal). A clean
// defensive rebound against a balanced floor is walked up, NOT run out — most of
// the conceding team has floor balance and gets back before the ball is advanced.
const FB_MIN_RUNWAY = 24; // ft from the rim: closer than this and there's no break to have
const FB_DREB_BASE = 0.01; // base break chance off a defensive rebound (balanced floor, long-board leak-out)
const FB_STEAL_BASE = 0.5; // base off a live steal (defense scrambling the wrong way)
const FB_CRASH_PIVOT = 58; // crashGlass at/above which an opponent commits to the offensive glass
const FB_CRASH_BONUS = 0.03; // per crashing opponent who lost floor balance and can't recover
const FB_PUSH_SLOPE = 0.004; // per point of advancer pushTransition above 50 (willingness multiplier)
const FB_SPEED_SLOPE = 0.004; // per point of advancer speed above 80 (a burner leaks out)
const FB_MAX = 0.8;

// ----- Outlet selection -----
// The break is led by whoever is furthest down the floor AND can handle it — the
// leak-out runner. Absent a leak-out, the ball goes to the primary playmaker to
// reset and walk it up.
const OUTLET_MIN_HANDLE = 62; // handle (stronger hand) needed to push/lead a break
const OUTLET_LEAK_MARGIN = 8; // ft a capable handler must be ahead of the recoverer to be the outlet

function handleOf(p: Player): number {
  return Math.max(p.attr.handleLeft, p.attr.handleRight);
}

/* The primary playmaker to reset and walk it up: the designated handler if there
   is one, else the best passer on the floor. */
function playmaker(off: Player[]): Player {
  const pg = off.find((p) => p.role === "handler");
  if (pg) return pg;
  return off.reduce((b, p) => (p.attr.pass > b.attr.pass ? p : b), off[0]);
}

function recoveryQuality(d: Player): number {
  return clamp((d.attr.iq * 0.45 + d.attr.perimD * 0.35 + d.attr.interiorD * 0.2 - 50) / 45, 0, 1);
}

export function fastBreakRecoveryTarget(d: Player, m: Player, atk: Point, onBall: boolean): Point {
  const speedEdge = m.attr.speed - d.attr.speed;
  const quality = recoveryQuality(d);
  const base = onBall ? FASTBREAK_RECOVERY_BASE + 0.04 : FASTBREAK_RECOVERY_BASE;
  const goalside = clamp(
    base - speedEdge * FASTBREAK_RECOVERY_SPEED_SLOPE + quality * FASTBREAK_RECOVERY_DEF_SLOPE,
    FASTBREAK_RECOVERY_MIN,
    FASTBREAK_RECOVERY_MAX,
  );
  return { x: lerp(m.x, atk.x, goalside), y: lerp(m.y, atk.y, goalside * 0.75) };
}

/* ----- SCORE TRANSITION -----
   After a made basket: hold the ball at the rim briefly, the conceding team
   inbounds from under that basket, a guard advances it up the floor, then we
   settle into the half-court set. skipScore=true for made free throws. */
export function beginScoreTransition(skipScore: boolean): void {
  const scored = G.attackHoop; // the hoop just scored on
  G.offense = G.offense === "home" ? "away" : "home"; // ball goes to the other team
  G.attackHoop = G.offense === "home" ? G.homeAttack! : G.awayAttack!;
  G.pendingAssist = null;
  G.driving = false;
  const off = offTeam(),
    def = defTeam(),
    inH = HOOP[scored];
  def.forEach((d, i) => (d.assign = off[i])); // new defense picks up new offense
  let inb = off[0],
    bd = 1e9;
  for (const p of off) {
    const dd = dist(p, inH);
    if (dd < bd) {
      bd = dd;
      inb = p;
    }
  } // nearest to baseline inbounds
  let pg = off.find((p) => p.role === "handler");
  if (!pg || pg === inb) pg = off.find((p) => p !== inb);
  off.forEach((p) => (p.hasBall = false));
  players().forEach((p) => {
    p.target = { x: p.x, y: p.y };
    p.offLaneT = 0;
    p.defLaneT = 0;
  }); // freeze briefly (no stale drift)
  G.trans = { phase: skipScore ? "inbound" : "score", t: 0, scored, inbounder: inb, pg: pg! };
  G.shotClock = 24;
  G.possClock = 0;
  G.holdT = 0;
  const back = scored === "R" ? 1 : -1;
  if (skipScore) {
    inb.x = clamp(inH.x + back * 5, 1, 93);
    inb.y = 25;
    inb.hasBall = true;
    G.ball.holder = inb;
    G.ball.x = inb.x;
    G.ball.y = inb.y;
  } else {
    G.ball.holder = null;
    G.ball.x = inH.x;
    G.ball.y = inH.y;
  }
  G.ball.state = "transition";
}

export function updateTransition(): void {
  const tr = G.trans!,
    atk = hoop(),
    inH = tr.scored ? HOOP[tr.scored] : null,
    off = offTeam(),
    def = defTeam();
  const back = tr.scored === "R" ? 1 : -1;
  tr.t += DT;
  const retreat = (): void =>
    def.forEach((d) => {
      if (d.assign) d.target = { x: lerp(d.assign.x, atk.x, 0.3), y: lerp(d.assign.y, atk.y, 0.25) };
    });
  if (tr.phase === "score") {
    G.ball.x = inH!.x;
    G.ball.y = inH!.y; // ball sits in the net so the bucket reads clearly
    if (tr.t > 0.7) {
      tr.phase = "inbound";
      tr.t = 0;
      tr.inbounder!.x = clamp(inH!.x + back * 5, 1, 93);
      tr.inbounder!.y = 25;
      tr.inbounder!.hasBall = true;
      G.ball.holder = tr.inbounder!;
    }
  } else if (tr.phase === "inbound") {
    G.ball.x = tr.inbounder!.x;
    G.ball.y = tr.inbounder!.y;
    const spot = { x: inH!.x - back * 10, y: 22 };
    tr.pg.target = spot;
    retreat();
    if ((tr.t > 0.9 && dist(tr.pg, spot) < 6) || tr.t > 2.4) {
      tr.phase = "inpass";
      tr.t = 0;
      tr.from = { x: tr.inbounder!.x, y: tr.inbounder!.y };
      tr.inbounder!.hasBall = false;
      G.ball.holder = null;
    }
  } else if (tr.phase === "inpass" || tr.phase === "outlet") {
    const f = clamp(tr.t / (tr.phase === "outlet" ? 0.5 : 0.45), 0, 1);
    G.ball.x = lerp(tr.from!.x, tr.pg.x, f);
    G.ball.y = lerp(tr.from!.y, tr.pg.y, f);
    retreat();
    if (tr.phase === "outlet") {
      off.forEach((p, i) => {
        if (p !== tr.pg && p !== tr.outletFrom) p.target = spotsFor(G.attackHoop)[i];
      });
    }
    if (f >= 1) {
      if (tr.outletFrom) tr.outletFrom.hasBall = false;
      tr.pg.hasBall = true;
      G.ball.holder = tr.pg;
      tr.phase = "advance";
      tr.t = 0;
    }
  } else if (tr.phase === "advance") {
    // FAST BREAK detection (live turnovers only): are fewer than ~2 defenders
    // back goalside, with a runway to the rim? If so, attack instead of pulling out.
    if (tr.fastbreak === undefined) {
      // Whether a live recovery is a true numbers break depends on the opponent's
      // floor balance, not on who happens to be goalside the instant the ball is
      // secured (everyone is still at the other end). A steal catches the defense
      // moving the wrong way; a defensive rebound only runs out when the opponent
      // crashed the glass and can't recover. pushTransition / advancer speed bias
      // how aggressively this team looks to run.
      if (tr.kind !== "live" || dist(tr.pg, atk) <= FB_MIN_RUNWAY) {
        tr.fastbreak = false;
      } else {
        let crashers = 0;
        for (const d of def) if (effectiveTendencies(d).crashGlass >= FB_CRASH_PIVOT) crashers++;
        const push = effectiveTendencies(tr.pg).pushTransition;
        // base advantage: a steal scrambles the defense; a clean rebound only runs
        // out when the opponent crashed the glass (each crasher is a man who can't
        // get back). push/speed scale how readily this team turns it into a break.
        const advantage = (tr.stealStart ? FB_STEAL_BASE : FB_DREB_BASE) + crashers * FB_CRASH_BONUS;
        const willToRun = clamp(0.7 + (push - 50) * FB_PUSH_SLOPE + Math.max(0, tr.pg.attr.speed - 80) * FB_SPEED_SLOPE, 0.5, 1.4);
        tr.fastbreak = chance(clamp(advantage * willToRun, 0, FB_MAX));
      }
      if (tr.fastbreak) {
        recordFastBreak(tr.stealStart ? "steal" : "dreb");
        G.banner = { text: "FAST BREAK", t: 80 };
      }
    }
    if (tr.fastbreak) {
      tr.pg.target = { x: atk.x, y: 25 }; // attack the rim
      off.forEach((p, i) => {
        if (p === tr.pg) return;
        const side = i % 2 ? 1 : -1;
        p.target = { x: lerp(p.x, atk.x, 0.55), y: 25 + side * 9 };
      }); // wings fill the lanes
      G.ball.x = tr.pg.x;
      G.ball.y = tr.pg.y;
      G.ball.from = tr.pg;
      def.forEach((d) => {
        const m = d.assign;
        if (!m || (tr.stealStart && tr.t < STEAL_REACTION_DELAY)) return;
        d.target = fastBreakRecoveryTarget(d, m, atk, m === tr.pg);
      });
      if (dist(tr.pg, atk) < 5.5) {
        // FINISH (open layup, or contested if a defender recovered)
        const contest = contestOf(tr.pg, def);
        G.trans = null;
        G.driving = false;
        attemptShot(tr.pg, "rim", contest, 2, makeProb(tr.pg, "rim", contest), true);
        return;
      }
      if (tr.t > 7) {
        settleHalfCourt(tr.pg);
      } // break broke down: settle
      return;
    }
    // no advantage: pull it out and run the half-court set
    const top = spotsFor(G.attackHoop)[0];
    tr.pg.target = { x: top.x, y: top.y };
    off.forEach((p, i) => {
      if (p !== tr.pg) p.target = spotsFor(G.attackHoop)[i];
    });
    G.ball.x = tr.pg.x;
    G.ball.y = tr.pg.y;
    G.ball.from = tr.pg;
    // transition defense: sprint back GOALSIDE of your man (between man and the rim),
    // so the on-ball defender is in front of the ball, not trailing behind it.
    def.forEach((d) => {
      const m = d.assign;
      if (!m || (tr.stealStart && tr.t < STEAL_REACTION_DELAY)) return;
      d.target = fastBreakRecoveryTarget(d, m, atk, m === tr.pg);
    });
    if ((dist(tr.pg, top) < 6 && tr.t >= BRINGUP_MIN_T) || tr.t > 9) {
      settleHalfCourt(tr.pg);
    }
  }
}

function settleHalfCourt(pg: Player): void {
  const off = offTeam(),
    def = defTeam();
  off.forEach((p, i) => {
    p.hasBall = p === pg;
    p.role = i === 0 ? "handler" : i === 4 ? "screener" : "spacer";
    p.ob = { state: "space", t: 0, spot: i };
  });
  def.forEach((d, i) => (d.assign = off[i]));
  G.ball.state = "held";
  G.ball.holder = pg;
  pg.hasBall = true;
  G.ball.from = pg;
  G.decideCD = 6;
  G.actionPhase = "bringup";
  G.actionT = 0;
  G.screen = null;
  G.screenerPick = undefined;
  G.pnrSwitched = false;
  G.driving = false;
  players().forEach((p) => {
    p.offLaneT = 0;
    p.defLaneT = 0;
  });
  G.trans = null;
}

/* ----- LIVE TRANSITION ----- steal / defensive rebound / shot-clock violation.
   No baseline inbound: the recovering team pushes the live ball up the floor.
   If the recoverer is not a guard, they outlet to the best ball handler first. */
export function beginLiveTransition(recoverer: Player, stealStart = false): void {
  G.offense = recoverer.team;
  G.attackHoop = recoverer.team === "home" ? G.homeAttack! : G.awayAttack!;
  G.pendingAssist = null;
  G.driving = false;
  const off = offTeam(),
    def = defTeam();
  def.forEach((d, i) => (d.assign = off[i]));
  off.forEach((p) => (p.hasBall = false));
  players().forEach((p) => {
    if (!p.target) p.target = { x: p.x, y: p.y };
    p.offLaneT = 0;
    p.defLaneT = 0;
  });
  // Advance the ball with whoever is furthest down the floor AND can actually
  // handle it — the leak-out runner ahead of the pack. If nobody has leaked out,
  // there's no break to lead, so reset and look for the primary playmaker.
  const atkRim = HOOP[G.attackHoop!];
  const dirToAtk = Math.sign(atkRim.x - recoverer.x) || 1;
  const fwd = (p: Player): number => p.x * dirToAtk; // larger = further down the floor toward the rim
  let runner: Player | null = null;
  let bestFwd = fwd(recoverer) + OUTLET_LEAK_MARGIN;
  for (const p of off) {
    if (p === recoverer || handleOf(p) < OUTLET_MIN_HANDLE) continue;
    if (fwd(p) > bestFwd) {
      bestFwd = fwd(p);
      runner = p;
    }
  }
  const pg = playmaker(off);
  // No leak-out: a guard pushes a live steal himself; otherwise (and on any
  // walk-up rebound by a non-handler) reset and find the primary playmaker.
  const recovererCanLead = handleOf(recoverer) >= OUTLET_MIN_HANDLE && (stealStart || recoverer === pg);
  const adv = runner ?? (recovererCanLead ? recoverer : pg);
  if (adv === recoverer || dist(recoverer, adv) < 7) {
    recoverer.hasBall = true;
    G.ball.holder = recoverer;
    G.ball.x = recoverer.x;
    G.ball.y = recoverer.y;
    G.trans = { kind: "live", phase: "advance", t: 0, pg: recoverer, stealStart };
  } else {
    G.ball.holder = null;
    G.ball.x = recoverer.x;
    G.ball.y = recoverer.y;
    G.trans = {
      kind: "live",
      phase: "outlet",
      t: 0,
      pg: adv,
      from: { x: recoverer.x, y: recoverer.y },
      outletFrom: recoverer,
      stealStart,
    };
  }
  G.shotClock = 24;
  G.possClock = 0;
  G.holdT = 0;
  G.ball.state = "transition";
  recordTransitionStart(stealStart ? "steal" : "dreb");
}
