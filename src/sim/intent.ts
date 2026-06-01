import type { Player, Point, ShotType } from "../types.js";

/* ---------- INTENTS ----------
   A decision is a VALUE, not a side effect. Each player's decider returns one
   Intent per tick; RESOLVE executes it (and is the only phase allowed to mutate
   game-logic state or consume rng). See docs/decide-pipeline-design.md.

   Players are referenced by stable identity (`toNum`/`manNum`/etc. are the OTHER
   player's `num`, scoped to the relevant team) so an intent can be carried over
   across ticks without dangling references. Targets (`to`) are carried so ACT can
   steer without re-deriving geometry. On-ball options carry a scalar `util` so the
   handler decider can pick the winner among mutually exclusive ball actions. */

export type Intent =
  // ----- offense: ball-handler (mutually exclusive; highest util wins) -----
  | { kind: "shoot"; type: ShotType; util: number }
  | { kind: "pass"; toNum: number; util: number }
  | { kind: "drive"; toward: Point; util: number }
  | { kind: "postUp"; util: number }
  | { kind: "hold" } // probe / reset — no ball action this window
  // ----- offense: off the ball -----
  | { kind: "cut"; lane: number; to: Point }
  | { kind: "screen"; forNum: number; to: Point }
  | { kind: "spaceTo"; to: Point } // relocate / fill / spacing
  | { kind: "crashGlass"; to: Point }
  // ----- defense -----
  | { kind: "contest"; manNum: number; to: Point } // guard your man at `to`
  | { kind: "help"; driverNum: number; to: Point } // rotate to wall up the driver
  | { kind: "closeout"; to: Point }
  | { kind: "boxout"; manNum: number; to: Point }
  | { kind: "switchOnto"; manNum: number } // PnR switch request — applied in RESOLVE
  // ----- contest layer (either side) -----
  | { kind: "goForBall"; to: Point } // loose ball / rebound pursuit
  | { kind: "stealAttempt"; targetNum: number }; // gamble in a passing lane

export type IntentKind = Intent["kind"];

export interface DecidedIntent {
  who: Player;
  intent: Intent;
}

/* ---------- constructors ----------
   Thin helpers so deciders read declaratively and the union stays the single
   source of truth for shape. */

export const hold = (): Intent => ({ kind: "hold" });
export const spaceTo = (to: Point): Intent => ({ kind: "spaceTo", to });
export const contest = (manNum: number, to: Point): Intent => ({ kind: "contest", manNum, to });

/* Among a handler's candidate ball-actions, the winner is the highest-util option
   (ties broken toward the earlier candidate — deterministic). `hold` has no util
   and only wins if no scored option clears its own threshold (decided upstream). */
export function bestBallAction(candidates: Intent[]): Intent {
  let best: Intent | null = null;
  let bestU = -Infinity;
  for (const c of candidates) {
    const u = "util" in c ? c.util : -Infinity;
    if (u > bestU) {
      bestU = u;
      best = c;
    }
  }
  return best ?? hold();
}
