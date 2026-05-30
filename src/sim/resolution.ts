import { HOOP, DT } from "../core/constants.js";
import { dist, clamp, chance, lerp } from "../core/math.js";
import { rng } from "../core/rng.js";
import { G, offTeam, defTeam, hoop, logEv } from "../core/state.js";
import { beginScoreTransition, beginLiveTransition } from "./transition.js";
import { setupPossession } from "./possession.js";
import { effectiveTendencies } from "./tendency.js";
import { simTunables } from "./tunables.js";
import { tacFor } from "../tactics/tactics.js";
import type { Player, Point, ShotType } from "../types.js";

/* ---------- 6) RESOLUTION ---------- */

// --- shooting foul tuning ---
// Inside (rim/close): base rate, then scaled by defender discipline/iq, size
// mismatch, shooter drawFoul, and team pressure/gamble.  Perimeter closeouts
// get a smaller base.  Target: ~18-26 FTA per team per game, FT/FGA ~0.18-0.26.
const FOUL_BASE_INSIDE = 0.42; // base probability for a contested inside shot
const FOUL_BASE_PERIM = 0.15; // base for a contested perimeter (mid/three) closeout
const FOUL_CONTEST_THRESH_INSIDE = 0.16; // min contest level to trigger inside check
const FOUL_CONTEST_THRESH_PERIM = 0.34; // tighter threshold for perimeter fouls
const FOUL_RATING_PIVOT = 62; // pivot for discipline/drawFoul (league average)
const FOUL_DISCIPLINE_SLOPE = 0.003; // per point below pivot -> +foul%; above -> -foul%
const FOUL_IQ_SLOPE = 0.002; // low defender IQ adds foul risk
const FOUL_DRAW_SLOPE = 0.0025; // per point above pivot for shooter drawFoul
const FOUL_MISMATCH_MAX = 0.08; // max added probability from size mismatch
const FOUL_HEIGHT_MISMATCH_THRESH = 0.3; // feet difference that triggers mismatch
const FOUL_TIGHT_BONUS = 0.06; // bonus when defending team plays tight pressure
const FOUL_GAMBLE_SLOPE = 0.0015; // per point above 50 gambleSteal tendency
const FOUL_CAP_INSIDE = 0.58; // absolute ceiling for inside foul probability
const FOUL_CAP_PERIM = 0.28; // ceiling for perimeter foul probability

// --- block tuning (moves BLK) ---
// lowered ceiling + flatter slope so blocks land ~4-6/team/game after tuning.
const BLOCK_BASE = 0.1; // floor block chance for any rim protector in the area
const BLOCK_PIVOT = 50; // block-attr pivot; defenders above this add, below subtract
const BLOCK_SLOPE = 1 / 720; // per (block-pivot) point; was 1/160
const BLOCK_CONTEST_MULT = 0.06; // contest contribution; was 0.10
const BLOCK_CAP = 0.13; // max block probability; was 0.28

// --- rebounding weight (heavier players hold position) ---
// Bounded so it nudges boards without dominating skill/height/box-out terms.
const REBOUND_WEIGHT_MULT = 0.18; // per normalized weight unit
const REBOUND_WEIGHT_NORM = 10; // (weight - 220) / NORM -> normalized weight units

// --- carom direction distribution ---
// Research: weak/opposite-side ~48%, same-side ~33%, center ~19%.
const CAROM_PROB_OPPOSITE = 0.48; // cumulative threshold for opposite-side carom
const CAROM_PROB_CENTER = 0.67;   // cumulative threshold for center carom (0.48+0.19); same-side is remainder

// --- carom distance model ---
// Opposite/weak-side caroms scale with shot distance (long shots -> longer caroms).
// Same-side and center caroms land closer to the rim regardless of distance.
const CAROM_OPP_BASE_DIST = 4.5;   // ft from rim: base distance for opposite-side carom
const CAROM_OPP_DIST_SCALE = 0.28; // fraction of shot distance added to opposite carom
const CAROM_SAME_BASE_DIST = 3.0;  // ft from rim: same-side caroms land close
const CAROM_SAME_DIST_SCALE = 0.10; // small fraction of shot distance for same-side
const CAROM_CENTER_BASE_DIST = 2.5; // center caroms land very close
const CAROM_MAX_DIST = 14.0;        // 97.5th-percentile cap: ~97.5% of boards within 14 ft
const CAROM_JITTER = 2.5;           // lateral/radial random spread around the carom spot

// --- free throw carom ---
const CAROM_FT_DIST = 3.5; // ft from rim: free-throw caroms land short and center

// --- weighted-random rebound winner ---
// Position (proximity to carom) dominates; rating is a modest multiplier.
// Lower decay = softer/flatter proximity curve = more spread across positions.
const REB_PROXIMITY_DECAY = 0.34;  // exponential decay; was 0.38
const REB_RATING_MIN = 0.60;       // minimum rating multiplier (low rebound attr player); was 0.70
const REB_RATING_MAX = 1.55;       // maximum rating multiplier (elite rebounder); was 1.40
const REB_RATING_PIVOT = 50;       // rebound attr at which multiplier = 1.0
const REB_RATING_SCALE = 0.0095;   // (attr - pivot) * scale; was 0.007 — wider skill spread
const REB_BOXOUT_DEF_BONUS = 2.20; // defensive box-out edge multiplier; was 1.22 — reduces OREB%
const REB_CRASH_MAX_BONUS = 0.3; // crashGlass weight boost for offensive players (1+bonus). NOTE: effect is modest under the soft positional draw (proximity dominates); strengthen via crashGlass-scaled convergence in the motion-offense overhaul.
const REB_LUCK_FLOOR = 0.0;        // flat base added to proximity weight so far-away players get a chance

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
  const tuning = simTunables();
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
      const bp = clamp(
        BLOCK_BASE + (prot.attr.block - BLOCK_PIVOT) * BLOCK_SLOPE + contest * BLOCK_CONTEST_MULT,
        0,
        BLOCK_CAP,
      );
      if (chance(bp)) {
        sh.stats.fga++;
        sh.stats.rimFga++;
        if ((type as ShotType) === "three") sh.stats.tpa++;
        if ("stats" in prot) prot.stats.blk++;
        logEv(`${(prot as Player).name} BLOCKS ${sh.name} at the rim!`, "to");
        missAndRebound(sh);
        return;
      }
    }
  }
  // shooting foul check — contested inside shots and perimeter closeouts
  {
    const isInside = type === "rim" || type === "close";
    const contestThresh = isInside ? FOUL_CONTEST_THRESH_INSIDE : FOUL_CONTEST_THRESH_PERIM;
    if (contest > contestThresh) {
      const nearDef = nearestDef(sh, def);
      const defPlayer = nearDef.d;
      const defTac = tacFor(defPlayer?.team ?? (sh.team === "home" ? "away" : "home"));
      const defTend = defPlayer ? effectiveTendencies(defPlayer) : null;

      // defender discipline and IQ — lower values foul more
      const disciplineAdj = defPlayer
        ? (FOUL_RATING_PIVOT - defPlayer.attr.discipline) * FOUL_DISCIPLINE_SLOPE
        : 0;
      const iqAdj = defPlayer ? (FOUL_RATING_PIVOT - defPlayer.attr.iq) * FOUL_IQ_SLOPE : 0;

      // shooter draw-foul skill — above pivot draws more fouls
      const drawAdj = (sh.attr.drawFoul - FOUL_RATING_PIVOT) * FOUL_DRAW_SLOPE;

      // size mismatch: small defender at the rim or slow big chasing a perimeter shooter
      let mismatchAdj = 0;
      if (defPlayer) {
        if (isInside && defPlayer.attr.height < sh.attr.height - FOUL_HEIGHT_MISMATCH_THRESH) {
          // undersized defender contesting inside — jumps into shooter
          mismatchAdj = clamp(
            (sh.attr.height - defPlayer.attr.height - FOUL_HEIGHT_MISMATCH_THRESH) * 0.18,
            0,
            FOUL_MISMATCH_MAX,
          );
        } else if (!isInside && defPlayer.attr.height > sh.attr.height + FOUL_HEIGHT_MISMATCH_THRESH) {
          // big slow defender closing out on a perimeter shooter
          mismatchAdj = clamp(
            (defPlayer.attr.height - sh.attr.height - FOUL_HEIGHT_MISMATCH_THRESH) * 0.12,
            0,
            FOUL_MISMATCH_MAX,
          );
        }
      }

      // tight pressure and gamble-steal tendency — both increase foul frequency
      const pressureAdj = defTac.pressure === "tight" ? FOUL_TIGHT_BONUS : 0;
      const gambleAdj = defTend
        ? clamp((defTend.gambleSteal - 50) * FOUL_GAMBLE_SLOPE, 0, 0.06)
        : 0;

      const foulScale = isInside ? tuning.fouls.insideScale : tuning.fouls.perimeterScale;
      const base = (isInside ? FOUL_BASE_INSIDE : FOUL_BASE_PERIM) * foulScale;
      const cap = isInside ? FOUL_CAP_INSIDE : FOUL_CAP_PERIM;
      const fp = clamp(base + disciplineAdj + iqAdj + drawAdj + mismatchAdj + pressureAdj + gambleAdj, 0, cap);

      if (chance(fp)) {
        beginFouled(sh, type, pts, chance(mp));
        return;
      }
    }
  }
  // normal field-goal attempt
  sh.stats.fga++;
  if (type === "rim" || type === "close") sh.stats.rimFga++;
  if (type === "three") sh.stats.tpa++;
  G.ball.state = "shot";
  G.ball.holder = null;
  sh.hasBall = false;
  G.ball.from = sh;
  G.ball.flight = 0;
  G.ball.passDur = Math.max(4, Math.round(dist(sh, hoop()) * 0.5));
  G.ball.shotMeta = { shooter: sh, made: chance(mp), pts, type, origin: { x: sh.x, y: sh.y } };
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

function caromLandingSpot(sh: Player, h: Point): Point {
  const meta = G.ball.shotMeta;
  const origin: { x: number; y: number } = meta?.origin ?? { x: sh.x, y: sh.y };
  const shotDist = dist(origin, h);

  // free-throw: short carom near the rim center
  if (meta?.type === undefined || (G.ft && G.ball.state === "freethrow")) {
    const angle = rng() * Math.PI * 2;
    return {
      x: clamp(h.x + Math.cos(angle) * CAROM_FT_DIST, 1, 93),
      y: clamp(h.y + Math.sin(angle) * CAROM_FT_DIST, 1, 49),
    };
  }

  // shooter-side: the side of the court the shooter is on (relative to centerline y=25)
  const shooterSide = origin.y < 25 ? -1 : 1; // -1 = low side, +1 = high side

  // pick carom direction via rng roulette
  const roll = rng();
  let caromDist: number;
  let lateralSign: number; // which y-side does the carom go?

  if (roll < CAROM_PROB_OPPOSITE) {
    // opposite/weak-side: longer carom, scales with shot distance
    caromDist = CAROM_OPP_BASE_DIST + shotDist * CAROM_OPP_DIST_SCALE;
    lateralSign = -shooterSide; // opposite side from shooter
  } else if (roll < CAROM_PROB_CENTER) {
    // center carom: short, close to rim center
    caromDist = CAROM_CENTER_BASE_DIST;
    lateralSign = 0; // no lateral bias
  } else {
    // same-side carom: shorter
    caromDist = CAROM_SAME_BASE_DIST + shotDist * CAROM_SAME_DIST_SCALE;
    lateralSign = shooterSide;
  }

  caromDist = clamp(caromDist, 1.5, CAROM_MAX_DIST);

  // direction from hoop toward shooter for the radial axis, then rotate based on lateral
  const dx = origin.x - h.x,
    dy = origin.y - h.y;
  const shotAngle = Math.atan2(dy, dx);
  // for opposite/same-side, add a lateral offset from the shooter angle
  const lateralOffset = lateralSign === 0 ? 0 : lateralSign * (Math.PI * 0.28);
  const caromAngle = shotAngle + lateralOffset + (rng() - 0.5) * CAROM_JITTER * 0.18;

  // radial jitter in distance
  const distJitter = (rng() - 0.5) * CAROM_JITTER;
  const finalDist = clamp(caromDist + distJitter, 1.5, CAROM_MAX_DIST);

  return {
    x: clamp(h.x + Math.cos(caromAngle) * finalDist, 1, 93),
    y: clamp(h.y + Math.sin(caromAngle) * finalDist, 1, 49),
  };
}

function missAndRebound(sh: Player): void {
  const tuning = simTunables();
  const h = hoop(),
    off = offTeam(),
    def = defTeam();
  const defSet = new Set(def);

  // compute the directional carom landing spot
  const carom = caromLandingSpot(sh, h);

  // build soft-weight roulette over all players
  const all = off.concat(def);
  const weights: number[] = [];
  let totalW = 0;

  for (const p of all) {
    const isDef = defSet.has(p);
    const dCarom = dist(p, carom);

    // proximity to carom landing spot dominates (exponential decay + luck floor)
    const proxWeight = Math.exp(-REB_PROXIMITY_DECAY * dCarom) + REB_LUCK_FLOOR;

    // rating factor: modest multiplier around 1.0
    const ratingMult = clamp(
      REB_RATING_MIN + (p.attr.rebound - REB_RATING_PIVOT) * REB_RATING_SCALE,
      REB_RATING_MIN,
      REB_RATING_MAX,
    );

    // height/vertical add a small physical edge (not dominant)
    const physMult = 1.0 + clamp((p.attr.height - 6.5) * 0.06 + p.attr.vertical * 0.003, -0.15, 0.30);

    // box-out: defenders get a small positional edge from boxing out
    const boxoutMult = isDef ? REB_BOXOUT_DEF_BONUS * tuning.rebounding.defensiveBoxoutScale : 1.0;

    // crashGlass tendency bonus for offensive players
    const crashBonus =
      !isDef && p.team === G.offense
        ? (effectiveTendencies(p).crashGlass / 100) * REB_CRASH_MAX_BONUS * tuning.rebounding.crashGlassScale
        : 0;

    // weight term for body mass (position-holding)
    const weightBonus = clamp(((p.attr.weight - 220) / REBOUND_WEIGHT_NORM) * REBOUND_WEIGHT_MULT, -0.05, 0.12);

    const w = Math.max(0.001, proxWeight * ratingMult * physMult * boxoutMult * (1 + crashBonus + weightBonus));
    weights.push(w);
    totalW += w;
  }

  // weighted-random draw (roulette wheel) — deterministic via rng()
  let pick = rng() * totalW;
  let best: Player | null = null;
  for (let i = 0; i < all.length; i++) {
    pick -= weights[i];
    if (pick <= 0) {
      best = all[i];
      break;
    }
  }
  if (!best) best = all[all.length - 1]; // floating-point safety

  if (!best) {
    best = nearestDef(h, def).d;
  }
  if (!best) return;

  best.stats.reb++;
  if (best.team === G.offense) best.stats.oreb++;
  else best.stats.dreb++;
  logEv(`${best.name} grabs the rebound`);
  if (best.team === G.offense) {
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

export function beginFouled(sh: Player, type: ShotType, pts: number, andOne: boolean): void {
  if (andOne) {
    // shot fell + foul: count bucket + 1 FT
    sh.stats.fga++;
    if (type === "rim" || type === "close") sh.stats.rimFga++;
    sh.stats.fgm++;
    if (type === "three") {
      sh.stats.tpa++; // a made three on an and-one must also count the attempt
      sh.stats.tpm++;
    }
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
