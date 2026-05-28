import { HOOP, DT } from "../core/constants.js";
import { dist, lerp, clamp } from "../core/math.js";
import { G, offTeam, defTeam, hoop, players, logEv } from "../core/state.js";
import { spotsFor } from "./possession.js";
import { contestOf, makeProb } from "./offense.js";
import { attemptShot } from "./resolution.js";
import type { Player, Point } from "../types.js";

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
  players().forEach((p) => (p.target = { x: p.x, y: p.y })); // freeze briefly (no stale drift)
  G.trans = { phase: skipScore ? "inbound" : "score", t: 0, scored, inbounder: inb, pg: pg! };
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
      const dirRim = Math.sign(atk.x - tr.pg.x) || 1;
      let back = 0;
      for (const d of def) {
        if (Math.sign(atk.x - d.x) === dirRim && Math.abs(atk.x - d.x) < Math.abs(atk.x - tr.pg.x) - 3) back++;
      }
      tr.fastbreak = tr.kind === "live" && back <= 1 && dist(tr.pg, atk) > 18;
      if (tr.fastbreak) G.banner = { text: "FAST BREAK", t: 80 };
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
        if (!m) return; // defenders race back goalside
        d.target = { x: lerp(atk.x, m.x, 0.15), y: lerp(atk.y, m.y, 0.2) };
      });
      if (dist(tr.pg, atk) < 5.5) {
        // FINISH (open layup, or contested if a defender recovered)
        const contest = contestOf(tr.pg, def);
        G.trans = null;
        G.driving = false;
        attemptShot(tr.pg, "rim", contest, 2, makeProb(tr.pg, "rim", contest));
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
      if (!m) return;
      const onBall = m === tr.pg;
      const t = onBall ? 0.22 : 0.3;
      d.target = { x: lerp(m.x, atk.x, t), y: lerp(m.y, atk.y, t * 0.7) };
    });
    if (dist(tr.pg, top) < 6 || tr.t > 9) {
      settleHalfCourt(tr.pg);
    }
  }
}

export function settleHalfCourt(pg: Player): void {
  const off = offTeam(),
    def = defTeam();
  def.forEach((d, i) => (d.assign = off[i]));
  G.ball.state = "held";
  G.ball.holder = pg;
  pg.hasBall = true;
  G.ball.from = pg;
  G.shotClock = 24;
  G.possClock = 0;
  G.decideCD = 6;
  G.actionPhase = "bringup";
  G.actionT = 0;
  G.screen = null;
  G.pnrSwitched = false;
  G.driving = false;
  G.trans = null;
}

/* ----- LIVE TRANSITION ----- steal / defensive rebound / shot-clock violation.
   No baseline inbound: the recovering team pushes the live ball up the floor.
   If the recoverer is not a guard, they outlet to the best ball handler first. */
export function beginLiveTransition(recoverer: Player): void {
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
  });
  let adv = off[0];
  for (const p of off) {
    if (p.attr.handle > adv.attr.handle) adv = p;
  }
  if (adv === recoverer || dist(recoverer, adv) < 7) {
    recoverer.hasBall = true;
    G.ball.holder = recoverer;
    G.ball.x = recoverer.x;
    G.ball.y = recoverer.y;
    G.trans = { kind: "live", phase: "advance", t: 0, pg: recoverer };
  } else {
    G.ball.holder = null;
    G.ball.x = recoverer.x;
    G.ball.y = recoverer.y;
    G.trans = { kind: "live", phase: "outlet", t: 0, pg: adv, from: { x: recoverer.x, y: recoverer.y }, outletFrom: recoverer };
  }
  G.ball.state = "transition";
}
