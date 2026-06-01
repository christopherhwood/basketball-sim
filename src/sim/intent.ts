import type { Player, Point, ShotType } from "../types.js";

/* ---------- BallDecision ----------
   The on-ball decider's PURE output. Unlike the off-ball intents, the ball
   handler's choice cannot be reduced to a single pre-noise pick in DECIDE: the
   legacy code adds randn()*noise to each utility BEFORE selecting (so both the
   winner AND hold-eligibility are post-noise), and that rng must live in RESOLVE.
   So DECIDE returns the four SCORED (pre-noise) utilities plus everything RESOLVE
   needs to add noise, pick the winner, run the drive-cutoff rolls, and execute.
   See docs/decide-pipeline-design.md and the RESOLVE SPEC. */
export interface BallDecision {
  who: Player;
  // pre-noise utilities
  shootU: number;
  driveU: number;
  passU: number;
  postU: number;
  // shot/contest context (for an executed shoot)
  type: ShotType;
  contest: number;
  mp: number;
  pts: number;
  open: number;
  dh: number; // distance handler -> hoop
  // pass context
  bestPass: Player | null;
  bestPU: number;
  // post context
  postDef: Player | null;
  postEdge: number;
  // drive target point (lerp toward the hoop)
  toward: Point;
}

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

/* ---------- OFF-BALL DECIDED INTENT ----------
   The pure off-ball decider's per-mover output. Unlike the simple `spaceTo`/`cut`/
   `screen` intents above (which describe a single chosen action), an off-ball
   mover's decision is a CURRENT deterministic target PLUS the eligibility of every
   rng transition it might take this tick. DECIDE evaluates each transition's
   geometric/role/clock GATE (no `chance(...)` roll); RESOLVE advances the `ob`
   state machine and rolls the eligible transitions in fixed per-mover order,
   overriding `to` with the transition target on a hit. Encoding eligibility (not
   the roll) is what keeps DECIDE pure and rng-free. See
   docs/decide-pipeline-design.md and resolveOffBall.

   `to` is the applied target if NO transition fires (the spacing/fill/cut/screen
   target computed in the reserved-set pass). Each `*Elig` flag is the pre-roll gate
   for a transition; the matching `*To`/`cutY` carry that transition's target so
   RESOLVE can apply it without re-deriving geometry. */
export interface OffBallDecision {
  who: Player;
  // applied target for the current state if no rng transition fires
  to: Point;
  // give-and-go cut (the passer cuts to the rim right after passing)
  giveGoElig: boolean;
  // backdoor cut vs tight ball-side denial
  backdoorElig: boolean;
  cutY: number; // rim-cut lane y used by give-and-go / backdoor / basket-cut
  // weak-side lift/fill into open space the moment the ball moves
  liftElig: boolean;
  liftTo: Point;
  // call/set an off-ball screen on the on-ball defender
  screenElig: boolean;
  screenTo: Point;
  // ball-reactive basket cut (base rate scaled by driveRim + bonuses)
  cutElig: boolean;
  cutChance: number; // post-gate probability RESOLVE rolls for the basket cut
  giveGoChance: number; // post-gate probability RESOLVE rolls for give-and-go
  backdoorChance: number; // post-gate probability RESOLVE rolls for the backdoor cut
  // deterministic state-machine markers (which legacy branch decide took) so
  // RESOLVE applies the ob.t / relocatedForDrive side-effects without re-deriving.
  cutState: boolean; // mover is already in "cut" this tick
  fillState: boolean; // mover is already in "fill"
  screenState: boolean; // mover is already in "screen"
  tookDriveRelocate: boolean; // space mover relocated weak-side for a drive this tick
  heldDriving: boolean; // space mover held its prior target during a drive (no relocate)
  heldDwell: boolean; // space mover held its prior target inside the dwell window
  retarget: boolean; // bottom-block spacing shift fired (>= RETARGET_MIN_SHIFT) → reset ob.t
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
