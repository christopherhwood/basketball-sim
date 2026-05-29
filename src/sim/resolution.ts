import { HOOP, DT } from "../core/constants.js";
import { dist, clamp, chance, lerp } from "../core/math.js";
import { rng } from "../core/rng.js";
import { G, offTeam, defTeam, hoop, logEv } from "../core/state.js";
import { beginScoreTransition, beginLiveTransition } from "./transition.js";
import { setupPossession } from "./possession.js";
import { tendenciesOf } from "./tendency.js";
import type { Player, Point, ShotType } from "../types.js";

/* ---------- 6) RESOLUTION ---------- */

function nearestDef(p: Point, def: Player[]): { d: Player | null; dd: number } {
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

export function attemptShot(sh: Player, type: ShotType, contest: number, pts: number, mp: number): void {
  G.lastShooter = sh;
  G.lastAssist = G.pendingAssist;
  G.pendingAssist = null;
  const def = defTeam();
  // block check on inside shots (a blocked shot still counts as a missed FGA)
  if (type === "rim" || type === "close") {
    const prot = def.reduce<Player | { attr: { block: number } }>(
      (b, d) => (dist(d, sh) < 5 ? (d.attr.block > b.attr.block ? d : b) : b),
      { attr: { block: 0 } },
    );
    if (prot.attr && prot.attr.block > 0) {
      const bp = clamp((prot.attr.block - 60) / 160 + contest * 0.1, 0, 0.28);
      if (chance(bp)) {
        sh.stats.fga++;
        if ((type as ShotType) === "three") sh.stats.tpa++;
        if ("stats" in prot) prot.stats.blk++;
        logEv(`${(prot as Player).name} BLOCKS ${sh.name} at the rim!`, "to");
        missAndRebound(sh);
        return;
      }
    }
  }
  // shooting foul on contested drives/layups -> trip to the line (handled visibly)
  if ((type === "rim" || type === "close") && contest > 0.4 && chance(0.16)) {
    beginFouled(sh, type, pts, chance(mp));
    return; // 2nd arg true = and-one (shot would have fallen)
  }
  // normal field-goal attempt
  sh.stats.fga++;
  if (type === "three") sh.stats.tpa++;
  G.ball.state = "shot";
  G.ball.holder = null;
  sh.hasBall = false;
  G.ball.from = sh;
  G.ball.flight = 0;
  G.ball.passDur = Math.max(4, Math.round(dist(sh, hoop()) * 0.5));
  G.ball.shotMeta = { shooter: sh, made: chance(mp), pts, type };
}

export function resolveShot(): void {
  const m = G.ball.shotMeta;
  if (!m) return;
  const sh = m.shooter;
  if (m.made) {
    sh.stats.fgm++;
    if (m.type === "three") sh.stats.tpm++;
    sh.stats.pts += m.pts;
    G.score[sh.team] += m.pts;
    if (G.lastAssist && G.lastAssist !== sh && G.lastAssist.team === sh.team) {
      G.lastAssist.stats.ast++;
    }
    logEv(`${sh.name} scores ${m.pts} (${m.type === "three" ? "3PT" : m.type})`, "sc");
    G.scoreFlash = { x: hoop().x, y: hoop().y, pts: m.pts, team: sh.team, t: 50 };
    beginScoreTransition(false);
  } else {
    logEv(`${sh.name} misses (${m.type})`);
    missAndRebound(sh);
  }
}

function missAndRebound(sh: Player): void {
  const h = hoop(),
    off = offTeam(),
    def = defTeam();
  const defSet = new Set(def);
  let best: Player | null = null,
    bw = -1;
  for (const p of off.concat(def)) {
    const dd = dist(p, h);
    if (dd > 13) continue;
    const isDef = defSet.has(p);
    // offensive players crash the glass according to their crashGlass tendency:
    // 0 -> nothing, 50 -> mild bump, 100 -> meaningful contest (still below the +14 box-out)
    const crash = !isDef && p.team === G.offense ? (tendenciesOf(p).crashGlass / 100) * 20 : 0;
    const w =
      p.attr.rebound * 0.6 +
      p.attr.height * 8 +
      p.attr.vertical * 0.25 +
      p.attr.strength * 0.2 +
      (13 - dd) * 4 +
      (isDef ? 14 : 0) +
      crash +
      rng() * 40; // defense boxes out -> edge
    if (w > bw) {
      bw = w;
      best = p;
    }
  }
  if (!best) {
    // nobody home, give to nearest defender
    best = nearestDef(h, def).d;
  }
  if (!best) return;
  best.stats.reb++;
  logEv(`${best.name} grabs the rebound`);
  if (best.team === G.offense) {
    // offensive board, keep ball, reset clock to 14
    G.ball.state = "held";
    G.ball.holder = best;
    best.hasBall = true;
    G.shotClock = Math.max(G.shotClock, 14);
    G.decideCD = 6;
    G.actionPhase = "screen";
  } else {
    beginLiveTransition(best);
  }
}

/* ----- FREE THROWS as a visible state machine -----
   Sets shooter at the line, lines everyone up along the lane, then for each
   attempt: windup -> ball arcs to the rim -> show make/miss -> short pause.
   On the final miss the rebound is live; otherwise the defense inbounds. */
function setupFTLineup(sh: Player): void {
  const h = hoop(),
    dir = G.attackHoop === "R" ? -1 : 1;
  const off = offTeam().filter((p) => p !== sh),
    def = defTeam();
  const block: Point[] = [
    { x: h.x + dir * 2.5, y: 18.5 },
    { x: h.x + dir * 2.5, y: 31.5 }, // low blocks (defense)
    { x: h.x + dir * 6, y: 17.5 },
    { x: h.x + dir * 6, y: 32.5 }, // next up   (offense)
    { x: h.x + dir * 9, y: 21 },
    { x: h.x + dir * 9, y: 29 },
  ]; // top of lane
  def.forEach((d, i) => (d.target = i < 2 ? block[i] : i < 3 ? block[4] : { x: h.x + dir * 17, y: 9 }));
  off.forEach((o, i) => (o.target = i < 2 ? block[2 + i] : { x: h.x + dir * 18, y: 42 }));
}

function beginFouled(sh: Player, type: ShotType, pts: number, andOne: boolean): void {
  if (andOne) {
    // shot fell + foul: count bucket + 1 FT
    sh.stats.fga++;
    sh.stats.fgm++;
    if (type === "three") sh.stats.tpm++;
    sh.stats.pts += pts;
    G.score[sh.team] += pts;
    if (G.lastAssist && G.lastAssist !== sh && G.lastAssist.team === sh.team) G.lastAssist.stats.ast++;
    logEv(`${sh.name} scores ${pts} AND the foul!`, "sc");
  } else {
    // missed shot + foul: no FGA, 2 FTs
    logEv(`${sh.name} is fouled on the shot`);
  }
  G.banner = { text: andOne ? "AND-ONE" : "SHOOTING FOUL", t: 100 };
  setupFTLineup(sh);
  sh.hasBall = false;
  const pct = clamp(0.64 + ((sh.attr.mid - 55) / 55) * 0.26, 0.5, 0.94);
  G.ft = { shooter: sh, total: andOne ? 1 : 2, idx: 0, phase: "setup", t: 0, pct, thisMade: false };
  G.ball.state = "freethrow";
  G.ball.holder = null;
}

export function updateFreeThrows(): void {
  const ft = G.ft;
  if (!ft) return;
  const h = hoop(),
    dir = G.attackHoop === "R" ? -1 : 1,
    lineX = h.x + dir * 13.75;
  ft.t += DT;
  ft.shooter.target = { x: lineX, y: 25 };
  if (ft.phase === "setup") {
    G.ball.x = ft.shooter.x;
    G.ball.y = ft.shooter.y;
    if (dist(ft.shooter, { x: lineX, y: 25 }) < 1.5 && ft.t > 0.7) {
      ft.phase = "windup";
      ft.t = 0;
    }
  } else if (ft.phase === "windup") {
    G.ball.x = ft.shooter.x;
    G.ball.y = ft.shooter.y - 1.2;
    if (ft.t > 0.8) {
      ft.idx++;
      ft.shooter.stats.fta++;
      ft.thisMade = chance(ft.pct);
      ft.from = { x: ft.shooter.x, y: ft.shooter.y };
      ft.phase = "flight";
      ft.t = 0;
    }
  } else if (ft.phase === "flight") {
    const f = clamp(ft.t / 0.6, 0, 1);
    G.ball.x = lerp(ft.from!.x, h.x, f);
    G.ball.y = lerp(ft.from!.y, h.y, f) - Math.sin(f * Math.PI) * 5;
    if (f >= 1) {
      if (ft.thisMade) {
        ft.shooter.stats.ftm++;
        ft.shooter.stats.pts++;
        G.score[ft.shooter.team]++;
        logEv(`${ft.shooter.name} makes free throw ${ft.idx} of ${ft.total}`, "sc");
      } else logEv(`${ft.shooter.name} misses free throw ${ft.idx} of ${ft.total}`);
      ft.phase = "result";
      ft.t = 0;
    }
  } else if (ft.phase === "result") {
    if (ft.t > 0.7) {
      if (ft.idx >= ft.total) {
        if (!ft.thisMade) {
          G.ball.state = "held";
          missAndRebound(ft.shooter);
        } // live miss
        else {
          G.scoreFlash = { x: hoop().x, y: hoop().y, pts: 1, team: ft.shooter.team, t: 45 };
          beginScoreTransition(true);
        }
        G.ft = null;
      } else {
        ft.phase = "windup";
        ft.t = 0;
      }
    }
  }
}

