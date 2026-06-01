# Decide Pipeline — Design

A staged, snapshot-based per-player decision architecture for the simulation engine.
Replaces the current ball-centric `offenseDecide()` / `defenseMove()` flow with a
uniform four-phase tick in which every player is an independent decider reading a
frozen world snapshot.

Research backing for the choices here lives in the conversation that produced this
doc (RoboCup `helios-base`, EA `SimpleTeamSportsSimulator`, the double-buffer
pattern, Box2D continuous-collision). This document is the engineering plan; it
does not restate the research.

## Why

The engine today centralizes intelligence on the ball-handler. `offenseDecide()`
runs the handler's shoot/drive/pass/post logic on a `decideCD` cadence; every other
offensive player follows an off-ball state machine (`p.ob`); defenders react in
`defenseMove()`. Three structural problems follow:

1. **Order-dependent perception.** `tick()` integrates offense, *then* reads those
   updated positions in `defenseMove()`, *then* integrates defense
   (`possession.ts` — "Offense integrates first so defense reads up-to-date
   offensive positions"). Whether a defender reacts to a cut this tick or next
   depends on iteration order, not basketball. This is the classic N-decider
   hazard the double-buffer pattern exists to remove.
2. **Hidden side effects inside "decide".** Deciding currently mutates shared
   state: the PnR switch swaps `d.assign` mid-`defenseMove` (`defense.ts`), hedge
   coverage scales `ball.vx/vy`, and the on-ball strip check consumes `rng`
   (`chance(tovP)`) in the middle of `offenseDecide`. Decisions and effects are
   interleaved, so neither is independently testable.
3. **Capped off-ball intelligence.** Only the handler truly *decides*. Independent
   off-ball reads (back-cut when overplayed, slip a screen, help-the-helper) are
   hard to express because non-handlers are scripted, not deliberating.

The fix is to make **decisions pure values** computed against a **frozen snapshot**,
then apply them in a single ordered resolution + integration step.

## Goals / non-goals

**Goals**
- Every player runs one `decide()` per tick (on a per-player cadence), reading a
  consistent frozen snapshot — order-independent perception.
- All randomness is consumed in one phase (RESOLVE), in a fixed documented order —
  determinism stays a port spec; the decision layer becomes rng-free and unit-testable.
- A clean `applyIntent(snapshot, intent) → snapshot'` primitive, which is the
  forward model a later shallow chain-search needs.
- Targeted swept-contest checks so 10 Hz ticks don't tunnel through screens/contests.

**Non-goals**
- Not raising the global tick rate; not adopting a physics engine; not ECS/SoA
  (≈14 entities — over-engineering).
- Not a behavior rewrite. The basketball logic is *re-homed*, not re-invented.
- Not full chain-search now. The pipeline is the substrate; chain-search is a later,
  contained upgrade to the on-ball decider.

## The four-phase tick

```
tick():
  guards + clocks            // dead-ball states, quarter end — unchanged
  snap   = sense()           // 1. SENSE   — frozen read model, built once
  ints   = decide(snap)      // 2. DECIDE  — per-player, pure(snap) → Intent, rng-FREE
  resolve(ints, snap)        // 3. RESOLVE — apply intents, arbitrate, all rng HERE
  integrate()                // 4. ACT     — steer toward targets, one pass, order-free
```

| Phase | Runs | Reads | Writes | RNG |
|-------|------|-------|--------|-----|
| SENSE | every tick | live `G` | builds `Snapshot` | no |
| DECIDE | every tick (per-player cadence) | `Snapshot` only | nothing (returns `Intent[]`) | **no** |
| RESOLVE | every tick | `Snapshot` + `Intent[]` | `G` (ball state, assigns, stats, fouls, TOs, targets) | **yes, fixed order** |
| ACT | every tick | `G.*.target`, velocities | positions, velocities, fatigue, ball-follow | no |

The two invariants that make this correct:

- **DECIDE reads only the snapshot.** No decider reads another player's
  just-written position or state. Eliminates problem (1).
- **All stochastic outcomes live in RESOLVE, consumed in a fixed iteration order**
  (home index 0..4, then away index 0..4; ball-events before player-events). This is
  a *stronger* determinism guarantee than today, where `rng` is consumed mid-decide
  in traversal order. Eliminates problem (2) and keeps golden vectors meaningful.

## Data structures

### Snapshot (SENSE output)

A partial, read-only copy of just the fields perception consumes — not a deep clone
of `G`. At ~14 players × a handful of numbers this is a few KB, rebuilt each tick.

```ts
// src/sim/snapshot.ts (new)
export interface PlayerView {
  ref: Player;            // identity + immutable attr/tendencies (read-only use)
  x: number; y: number;
  vx: number; vy: number;
  hasBall: boolean;
  team: TeamSide;
  assignNum: number | null;   // assignment frozen at tick start
  role: string;
  obState: string | null;     // off-ball state, frozen
}

export interface Snapshot {
  off: PlayerView[];          // offensive team this tick
  def: PlayerView[];
  all: PlayerView[];
  byRef: Map<Player, PlayerView>;
  ball: { x: number; y: number; state: string; holderNum: number | null };
  hoop: Point;
  dir: -1 | 1;                // attack direction
  shotClock: number; possClock: number; gameClock: number;
  driving: boolean;
  tacOff: Tactics; tacDef: Tactics;
}
```

`sense()` snapshots positions/velocities/state and precomputes the **shared**
derived facts every decider would otherwise recompute (build-once, query-many):
nearest-defender map, per-player contest value, lane-clear flags, open-spot set.
These are pure functions of the frozen positions, so computing them once is both
faster and a guarantee that all deciders see the same numbers.

### Intent (DECIDE output)

A discriminated union. Decisions are *described*, not executed.

```ts
// src/sim/intent.ts (new)
export type Intent =
  // offense — ball
  | { kind: "shoot"; type: ShotType; util: number }
  | { kind: "pass"; toNum: number; util: number }
  | { kind: "drive"; toward: Point; util: number }
  | { kind: "postUp"; util: number }
  | { kind: "hold" }                              // probe / reset
  // offense — off ball
  | { kind: "cut"; lane: number; to: Point }
  | { kind: "screen"; forNum: number; to: Point }
  | { kind: "spaceTo"; to: Point }                // relocate / fill
  | { kind: "crashGlass"; to: Point }
  // defense
  | { kind: "contest"; manNum: number; to: Point }
  | { kind: "help"; driverNum: number; to: Point }
  | { kind: "closeout"; to: Point }
  | { kind: "boxout"; manNum: number; to: Point }
  | { kind: "switchOnto"; manNum: number }        // PnR switch request (resolved, deferred)
  // either side, contest layer
  | { kind: "goForBall"; to: Point }              // loose ball / rebound pursuit
  | { kind: "stealAttempt"; targetNum: number };  // gamble in a passing lane

export interface DecidedIntent { who: Player; intent: Intent; }
```

Intents carry their **target point** (`to`) so ACT can steer without re-deriving it,
and on-ball options carry a scalar `util` so RESOLVE can pick the winner among
mutually exclusive ball actions.

### Per-player cadence

Generalize the single `G.decideCD` to per-player `p.decideCD`. A player re-decides
when their counter hits 0, otherwise **carries over** the prior tick's intent
(stored on the player). Cadences are staggered (offset by index) so deciders don't
all fire the same tick — cheaper and less robotic. SENSE/RESOLVE/ACT still run every
tick, so movement and contests stay continuous between decisions.

```ts
function decide(s: Snapshot): DecidedIntent[] {
  return s.all.map(v => {
    const p = v.ref;
    if (p.decideCD > 0) { p.decideCD--; return { who: p, intent: p.lastIntent ?? hold() }; }
    p.decideCD = decideInterval(p, s);          // ~3–5 ticks, role/handle scaled
    const intent = decideFor(v, s);
    p.lastIntent = intent;
    return { who: p, intent };
  });
}
```

## The deciders — where current logic re-homes

`decideFor(view, snap)` dispatches by side / on-ball / off-ball. Each branch is the
*existing* logic, refactored to read `snap` and **return** an `Intent` instead of
mutating `G` or setting `p.target`.

| Decider | Source today | Returns |
|---------|--------------|---------|
| On-ball handler | `offenseDecide()` ball-handler block (`offense.ts`): shoot/drive/pass/post utility, `selM`, `shootU`, urgency, post-feed | `shoot` / `pass` / `drive` / `postUp` / `hold` (highest `util`) |
| Off-ball offense | `offBallMove()` + `p.ob` state machine + `runAction()` cut/screen/space | `cut` / `screen` / `spaceTo` / `crashGlass` |
| On-ball defender | `defenseMove()` on-ball block (pressure, sag, lookahead) | `contest` (with target point) |
| Off-ball defender | `offBallDefensiveTarget()` ("on the line, up the line", tracking lag) | `contest` / `spaceTo` |
| Help defender | `defenseMove()` help block (4 gates) | `help` (recognition gamble deferred to RESOLVE) |
| Closeout | `defenseMove()` closeout-rotation block | `closeout` |
| PnR coverage | `defenseMove()` screen block (switch/drop/hedge) | `switchOnto` / `contest` (drop/hedge positioning) |
| Rebound pursuit | `updateShotFlightConvergence()` (`possession.ts`) | `crashGlass` / `boxout` / `goForBall` |

Two refactors of note while re-homing:

- **The help-recognition gamble** (`chance(rec)` deciding `helpCommit`) is rng and
  therefore **must move to RESOLVE**. DECIDE emits a `help` intent unconditionally
  when the gates that are *deterministic* (beaten, in-range) pass; RESOLVE rolls the
  one-per-drive recognition and either commits the helper or not. `helpCommit`
  remains the per-drive memo, just written in RESOLVE.
- **PnR switch / hedge** are state/physics side effects today. Switch becomes a
  `switchOnto` intent applied in RESOLVE (swap `assign` once, set `pnrSwitched`).
  Hedge's `ball.vx *= 0.85` becomes a RESOLVE effect (a contest slowing the
  handler), not a write buried in a decide function.

Special game phases (free throws, transition, shot-in-flight rebound convergence)
keep their dedicated handlers; `tick()` routes to them before the
sense→decide→resolve→act path, exactly as it routes today. The pipeline governs the
**live half-court possession**, which is where the decision complexity is.

## RESOLVE — arbitration, contests, effects

RESOLVE is the only phase that mutates game-logic state and the only one that
touches `rng`. It runs a fixed sequence:

1. **Ball-action arbitration.** Among the ball-handler's mutually exclusive intents
   the highest `util` already won inside DECIDE; RESOLVE *executes* it: `shoot`
   starts a shot (sets `ball.state`, `shotMeta`), `pass` calls `startPass`, `drive`
   sets `G.driving` + steering, `postUp` enters the post branch, `hold` probes.
2. **Contest resolution with swept checks.** This is the tunneling fix. For pairs
   that matter at speed — the live pass (passer→receiver segment) vs. defender
   bodies, a driver vs. help wall, a closeout vs. a catch-and-shoot — test the
   *path segment* this tick against the contesting body, not just endpoints. A
   player at top speed covers 2.4 ft/tick, enough to skip a ~2 ft contest cylinder;
   the swept segment check restores the contact. This is per-pair and cheap (no
   global CCD). Steal/strip/interception probabilities (`chance(...)`) are rolled
   here, in fixed order.
3. **Defensive state effects.** Apply `switchOnto` (swap `assign`, set
   `pnrSwitched`), commit/decline `help` recognition, hedge ball-slow.
4. **Stat / foul / turnover bookkeeping.** The strip TO, steal credit, assist
   priming (`pendingAssist`, `catchShoot`) — all the `recordTO` / `stats.*` writes
   currently scattered in decide, centralized here.
5. **Lower intents to steering targets.** Every non-ball intent sets `who.target`
   from its `to`. (Ball-handler target follows from the executed action.)

Because all `rng` draws happen here in a fixed order over a frozen snapshot, a given
(seed, pre-tick state) produces identical outcomes regardless of how DECIDE iterated
— which is what keeps `newGame(seed)` reproducible and the golden vectors valid.

## ACT — integration

Unchanged in spirit from `moveTeam()` / `moveAll()` (`movement.ts`): steer each
player toward `p.target` with arrive-ramping and separation, integrate position,
update fatigue, then snap the ball to its holder. The difference: it now runs as a
**single pass over all players** because targets were all computed from the same
snapshot. The "offense integrates first" ordering hack is deleted — order no longer
changes perception, so a uniform pass is correct. The 1-tick reaction latency that
hack hid is uniform and realistic (humans have reaction delay anyway).

## Determinism contract

This is the load-bearing property of the engine (`CLAUDE.md`: the seeded engine is a
port spec). The pipeline must preserve it, and actually tightens it:

- **DECIDE is pure and rng-free.** Given a snapshot, intents are a deterministic
  function of frozen state. Unit-testable without a seed.
- **RESOLVE consumes `rng` in a fixed, documented order**: ball events first, then
  players in `[home0..home4, away0..away4]` order, each player's sub-rolls in a
  fixed order. The order is independent of DECIDE traversal and of player movement.
- **SENSE and ACT never touch `rng`.**

Any change to the RESOLVE ordering is a deliberate, documented golden re-baseline —
never an accident of refactoring.

## Forward model + chain-search (later)

The resolve/integrate split yields `applyIntent(snapshot, intent) → snapshot'`
almost for free: a deterministic (rng-free, or mean-valued) projection of one
candidate action onto the frozen world. With that primitive, the on-ball decider
graduates from greedy single-step to a shallow best-first search:

```
decideHandler(view, snap):
  candidates = generate(view, snap)        // shoot / pass(targets) / drive / postUp
  best = argmax_{c in candidates} evaluate(applyIntent(snap, c))   // depth-1
  // depth-2 optional: expand best few, e.g. pass → catch-and-shoot value
  return best.intent
```

`evaluate` is an EPV-style state score (expected points from the projected state),
generalizing the existing shot-quality math. Depth 1 already beats today's greedy
choice by valuing options on their *projected* outcome rather than current state;
depth 2 captures pass-and-relocate. This stays contained to the handler decider —
the other nine players are already real deciders by then.

## Migration plan

Each step is independently shippable and keeps the suite greenable. Golden-digest
re-baselines are expected at the marked steps (`CLAUDE.md`); the invariant and
statistical tests guard against real regressions, and `npm run sim` confirms box
scores stay realistic at every step.

1. **Scaffolding (behavior-neutral).** Add `snapshot.ts`, `intent.ts`, the four-phase
   `tick()` skeleton. Initially DECIDE wraps the *current* mutations as a trivial
   pass-through so output is unchanged. Re-baseline once if iteration shifts.
2. **Frozen snapshot for SENSE.** Point existing reads at `snap` instead of live `G`.
   This is the first real behavior shift (defense no longer sees same-tick offense
   moves) → re-baseline; verify PPP/box scores via `npm run sim`.
3. **Defenders → deciders.** Convert `defenseMove()` to per-defender `decideFor`
   returning `contest`/`help`/`closeout`/`switchOnto`; move the help gamble and PnR
   switch into RESOLVE. Smallest self-contained surface; proves the shape and
   measures re-baseline cost. *(Recommended vertical slice.)*
4. **Off-ball offense → deciders.** Re-home `offBallMove()` + `p.ob` into
   `cut`/`screen`/`spaceTo` intents.
5. **On-ball handler → decider.** `offenseDecide` ball block returns an `Intent`;
   strip/turnover rolls move to RESOLVE.
6. **Swept contest checks** in RESOLVE for screen/contest/steal pairs (tunneling).
7. **(Later) Forward model + shallow chain-search** on the handler decider.

Steps 3–5 are the bulk; each converts one decider family and re-baselines the digest.

## Risks & open questions

- **Re-baseline churn.** Steps 2–5 each shift deterministic output. Mitigation: keep
  changes behavior-minimal per step, lean on statistical tests + `npm run sim`, and
  treat each digest update as a reviewed checkpoint, not a rubber stamp.
- **Partial vs full snapshot.** Plan is partial (only perceived fields). If a decider
  turns out to read something un-snapshotted, either add the field or accept a live
  read for that specific value (documented). Full deep-copy of `G` is the fallback if
  partial proves leaky, at a small per-tick cost.
- **Tick rate for contests.** 10 Hz + swept checks is the plan. If screen-navigation
  / box-out fidelity later needs more, prefer **per-pair substep** in RESOLVE over a
  global rate change (keeps everything else at 0.1 s). Open until those mechanics
  exist.
- **`runAction()` play structure.** It currently sequences possessions (bringup →
  action) somewhat globally. Decide whether play-call structure stays a thin global
  layer that *biases* per-player intents (likely) or is fully dissolved into them.
- **Cadence vs responsiveness.** Carrying over intents between decisions can look
  laggy for defenders reacting to a sudden drive. Mitigation: event-triggered
  re-decide (force `decideCD = 0` on possession/ball-state change), not just the
  fixed counter.

## Symbol map (current → pipeline)

| Today | Becomes |
|-------|---------|
| `offenseDecide()` | `decideFor` (on-ball + off-ball offense) + RESOLVE for rng/effects |
| `defenseMove()` | `decideFor` (defender families) + RESOLVE for switch/help/hedge |
| `offBallDefensiveTarget()` | off-ball defender decider (returns intent `to`) |
| `offBallMove()` / `p.ob` | off-ball offense decider |
| `updateShotFlightConvergence()` | rebound-pursuit deciders (`crashGlass`/`boxout`) |
| `moveTeam()` / `moveAll()` | ACT (single pass; ordering hack removed) |
| `G.decideCD` | per-player `p.decideCD` (+ `p.lastIntent`) |
| strip check `chance(tovP)` in decide | RESOLVE contest, fixed-order rng |
| PnR `d.assign` swap in decide | `switchOnto` intent applied in RESOLVE |
</content>
</invoke>
