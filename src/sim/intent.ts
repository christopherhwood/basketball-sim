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
  // the handler WANTS a ball screen this tick — his own read: running a PnR, CONTAINED
  // (no open shot, no open lane, no good pass), so he calls a big up for a pick. The
  // orchestrator turns this into a callScreen.
  wantsScreen: boolean;
  // a clear attack opened up (open shot or open lane) — wave off a called pick that
  // hasn't set yet. Separate from !wantsScreen so there's HYSTERESIS: a called pick
  // persists through the in-between zone instead of churning call→reject every tick.
  screenWaveOff: boolean;
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

/* ---------- OFF-BALL CANDIDATE + DECIDED INTENT ----------
   Off-ball offense is a per-tick UTILITY decider, mirroring the ball-handler's
   decide(score)→resolve(noise+select+execute) split — NOT an rng-gated state
   machine. For each FREE (not mid-commitment) non-handler mover, DECIDE SCORES a
   set of candidate actions (holdSpace / cut / screen / lift) off the snapshot,
   each modulated by effectiveTendencies, and returns them. RESOLVE adds decision
   NOISE to the utilities, picks the best, and COMMITS it (sets ob.state, resets
   ob.t, applies the target). A mover MID-COMMITMENT (in cut/screen/fill and not
   expired) is NOT re-scored — it continues its action (hysteresis: prevents
   per-tick jitter). All rng (the noise) lives in RESOLVE, consumed in fixed
   per-mover order, so the seeded stream stays a port spec. See
   docs/decide-pipeline-design.md and resolveOffBall. */

export type OffBallActionKind = "holdSpace" | "cut" | "screen" | "lift";

export interface OffBallCandidate {
  kind: OffBallActionKind;
  util: number; // pre-noise utility (effectiveTendencies-modulated)
  to: Point; // target point this action steers toward
  cutY?: number; // rim-cut lane y (cut only)
  screenTo?: Point; // screen-set point (screen only)
}

export interface OffBallDecision {
  who: Player;
  // applied target for the current state (committed continuation OR holdSpace base)
  to: Point;
  // scored candidates a FREE mover chooses among (empty when mid-commitment).
  candidates: OffBallCandidate[];
  committed: boolean; // mover is mid-commitment this tick → continue, do NOT re-score
  // deterministic state-machine markers (which commitment branch decide took) so
  // RESOLVE advances the ob.t / relocatedForDrive lifecycle without re-deriving.
  cutState: boolean; // mover is already in "cut" this tick
  fillState: boolean; // mover is already in "fill"
  screenState: boolean; // mover is already in "screen"
  rollState: boolean; // pnr screener is already rolling to the rim
  popState: boolean; // pnr screener is already popping beyond the arc
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
