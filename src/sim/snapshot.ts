import { G, offTeam, defTeam, hoop } from "../core/state.js";
import { tacFor } from "../tactics/tactics.js";
import type { Player, Point, TeamSide, Tactics } from "../types.js";

/* ---------- SNAPSHOT ----------
   The frozen read model for one tick. Built once in SENSE; every decider reads
   from it and only from it. Positions/velocities/state are copied so DECIDE is a
   pure function of tick-start state — no decider sees another's would-be effects,
   and integration order can no longer change perception.

   Immutable per-tick facts (attr, tendencies, identity) are reached through `ref`;
   only the mutable spatial/possession fields are copied. See
   docs/decide-pipeline-design.md. */

export interface PlayerView {
  ref: Player; // identity + immutable attr/tendencies (do NOT read .x/.y/.vx off this)
  num: number;
  team: TeamSide;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hasBall: boolean;
  role: string;
  assignNum: number | null; // assignment frozen at tick start
  obState: string | null; // off-ball state, frozen
  target: Point | null; // the player's prior target, frozen (spacing reads it purely)
}

export interface Snapshot {
  off: PlayerView[];
  def: PlayerView[];
  all: PlayerView[];
  byRef: Map<Player, PlayerView>;
  ball: { x: number; y: number; state: string; holderNum: number | null; fromNum: number | null };
  hoop: Point;
  dir: -1 | 1; // attack direction along x (toward the attacked hoop)
  shotClock: number;
  possClock: number;
  gameClock: number;
  driving: boolean;
  tacOff: Tactics;
  tacDef: Tactics;
}

function viewOf(p: Player): PlayerView {
  return {
    ref: p,
    num: p.num,
    team: p.team,
    x: p.x,
    y: p.y,
    vx: p.vx,
    vy: p.vy,
    hasBall: p.hasBall,
    role: p.role,
    assignNum: p.assign ? p.assign.num : null,
    obState: p.ob ? p.ob.state : null,
    target: p.target,
  };
}

export function sense(): Snapshot {
  const offArr = offTeam();
  const defArr = defTeam();
  const off = offArr.map(viewOf);
  const def = defArr.map(viewOf);
  const all = off.concat(def);
  const byRef = new Map<Player, PlayerView>();
  for (const v of all) byRef.set(v.ref, v);

  return {
    off,
    def,
    all,
    byRef,
    ball: {
      x: G.ball.x,
      y: G.ball.y,
      state: G.ball.state,
      holderNum: G.ball.holder ? G.ball.holder.num : null,
      fromNum: G.ball.from ? G.ball.from.num : null,
    },
    hoop: hoop(),
    dir: G.attackHoop === "R" ? -1 : 1,
    shotClock: G.shotClock,
    possClock: G.possClock,
    gameClock: G.gameClock,
    driving: !!G.driving,
    tacOff: tacFor(G.offense),
    tacDef: tacFor(G.offense === "home" ? "away" : "home"),
  };
}

/* ---------- frozen-view query helpers ----------
   Deciders use these instead of touching live `G` so the snapshot stays the only
   source of spatial truth. */

export const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

export function offByNum(s: Snapshot, num: number): PlayerView | null {
  return s.off.find((v) => v.num === num) ?? null;
}
export function defByNum(s: Snapshot, num: number): PlayerView | null {
  return s.def.find((v) => v.num === num) ?? null;
}
export function ballHolderView(s: Snapshot): PlayerView | null {
  if (s.ball.holderNum == null) return null;
  return s.off.find((v) => v.num === s.ball.holderNum) ?? null;
}
export function nearestDefView(s: Snapshot, p: { x: number; y: number }): PlayerView | null {
  let best: PlayerView | null = null;
  let bd = Infinity;
  for (const d of s.def) {
    const dd = dist2(d, p);
    if (dd < bd) {
      bd = dd;
      best = d;
    }
  }
  return best;
}
