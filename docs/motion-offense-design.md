# Motion-offense design

Implementation spec for the offense overhaul: a living off-ball offense — purposeful cuts, screens, and relocations that react to the ball, plus runnable set plays and a read-and-react continuity default. Built on PR 6 (role-true spacing), the rebounding convergence, per-player tendencies, and coaching. Deterministic (all randomness via `rng()`).

Grounded in the research in [movement-and-plays-design] (Context Steering, Cervone micro/macro split, Zhan macro-intent, PLOS ONE cut reads, BMOS/PPCF).

## Architecture — three layers over the existing micro/macro tick

Our engine already has the validated micro/macro shape: per-tick movement + discrete ball events (`offenseDecide`). We add two layers above movement and formalize a third.

### Layer A — Macro-intent (decisions / roles) — new `src/sim/intent.ts`

Each off-ball player holds a current **Intent** that changes on a coarse clock (~0.4–1.5 s) or on events (pass caught, drive begun, screen set). Per tick the player pursues the intent's target; the ball-handler keeps the existing `offenseDecide` (shoot/drive/pass/post). Intents replace the ad-hoc logic in `offBallMove`.

```ts
type IntentKind =
  | "spot"       // hold a floor spot (perimeter slot for shooters, inside for bigs)
  | "cut"        // basket cut to the rim, then refill
  | "backdoor"   // backdoor cut vs an overplaying/denying defender
  | "giveAndGo"  // cut to the rim right after passing
  | "relocate"   // slide to open space (lift/drift along the arc, weak-side)
  | "ballScreen" // go set an on-ball screen for the handler
  | "offScreen"  // set an off-ball screen (down/flare/pin) for a teammate
  | "useScreen"  // come off a screen (curl/fade/straight) to get open
  | "post"       // post up on the block, seal for a feed
  | "handoff"    // dribble hand-off give/receive
  | "fill";      // fill a vacated spot / behind a drive

type ReadKey = "switch" | "under" | "over" | "help" | "deny" | "open";

type Intent = {
  kind: IntentKind;
  target: Point;          // recomputed each tick from context
  forPlayerNum?: number;  // screen target / handoff partner
  spotIndex?: number;     // floor slot id
  read?: ReadKey;         // an active read that can branch the intent
  until?: number;         // possClock time / condition to re-decide
};
```

**Intent selection** (per player, on the coarse clock) is a utility over candidate intents weighted by:
- **tendencies** (`driveRim`→cut, `screen`→ball/off-screen, `shootThree`→relocate / useScreen-fade, `postUp`→post),
- **reads** (defender depth/overplay→backdoor; help committed→relocate weak-side; ball side→strong/weak-side role),
- the **active play** (if a set is called, the play dictates this role's intent for the current beat),
- **floor balance** (exactly one `ballScreen`; keep ≥2 perimeter spacers; no two players claiming the same spot),
- **IQ** (decision noise / read quality).

**Coordination:** a per-possession role map assigns the five to roles (handler, screener(s), shooters, cutter, post) from tendencies/lineup; the active play overrides per beat. A lightweight team coordinator enforces the floor invariants (one ball-screen at a time, balanced spacing, strong/weak-side assignment relative to the ball).

### Layer B — Context Steering (movement) — `src/sim/movement.ts`

Replace target-seek with interest/danger heading selection (N≈16 direction slots):
- **Interest map:** toward the intent target (Gaussian falloff around the slot), toward open space / the lane (when cutting), minor toward the ball (handoff/post feed).
- **Danger map:** defenders (slots pointing through a near defender), teammates (anti-bunch, inverse-square separation), out-of-bounds, strong-side congestion.
- **Pick:** mask interest by the lowest-danger threshold, choose the highest remaining interest slot, move at speed ∝ interest, with Reynolds `arrive` (decel near target) and the existing `maxSpeed`/accel clamps. Behaviors are stateless per tick; deterministic (seeded tie-break only).

Steering is the biggest engine swap; it can be de-risked by shipping **separation first** (add inverse-square anti-bunch to the current seek) before the full context-map heading selection.

### Layer C — Discrete ball actions (unchanged structurally)

`offenseDecide` (shoot/drive/pass/post) and transitions stay as-is. Intents change *where* off-ball players are, which is what makes pass targets open. Screen set/use coordinate via Layer A + the screen model below.

## Set-play encoding (the schema)

A play is **data**: a sequence of beats, each assigning per-role intents with optional read branches. Roles are abstract (1=PG…5=C), mapped to actual players by the role map.

```ts
type Role = 1 | 2 | 3 | 4 | 5;
type BeatAction = { role: Role; intent: IntentKind; arg?: Role | number };
type Beat = {
  actions: BeatAction[];                       // what each involved role does this beat
  advance: { on: "screenSet" | "catch" | "cut" | "time"; t?: number }; // when to move on
  reads?: Partial<Record<ReadKey, number>>;    // branch to a beat index on a read
};
type Play = {
  id: string;
  name: string;
  formation: number[];                          // initial spot ids per role
  beats: Beat[];
  prefer?: { needThree?: boolean; vsSwitch?: boolean; quick?: boolean };
};
```

**Execution:** a per-possession `PlayState { play, beatIndex, beatT }`. Each tick, set each involved role's Intent from the current beat; when `advance.on` fires, increment `beatIndex`; `reads` branch the index. Non-involved players run continuity defaults. When the play ends or the shot clock pressures, fall back to continuity. Beats are nodes, `advance`/`reads` are edges — a deterministic option tree.

**Example — Horns:** formation = 1 top, 4 & 5 elbows, 2 & 3 corners.
- beat 0: `{1: useScreen(of 5), 5: ballScreen(for 1), 4: spot}` — advance `on: screenSet`.
- beat 1: `{5: cut|relocate}` (roll if `shootThree<70`, pop if shooter); reads `{ switch: 2 (→ 4 re-screens for 2), help: 3 (→ 1 kickout relocate) }`.

A starter playbook: Horns, P&R (side/middle), Floppy, Pin-down, Dribble-handoff, plus "Motion" = pure continuity.

## Play-calling policy

Per possession / after a dead ball, pick a play (or "free"/continuity) by utility over:
- **coaching gameplan** (favor sets vs. "let them play"; specific set emphasis),
- **personnel** (shooters→floppy/pin-downs; a post→post sets; a great PG→P&R),
- **situation** (late clock→quick hitter; need a three→shooter set; after-timeout set),
- **defense** (vs switch→screen-the-screener; vs drop→P&R pull-up),
- **variety** (avoid repeating the same call).

Default to continuity when nothing is called or a set breaks down.

## Continuity / read-and-react (the default living offense)

Looping rule-based intents so the floor is alive without scripted plays:
- **Pass-and-cut:** after passing, the passer `giveAndGo` or `relocate`s; teammates `fill`.
- **Fill behind drives:** on a drive, strong-side players clear weak-side; the dunker big seals (we have a rough version).
- **Screen-away:** a weak-side player sets a down-screen (`offScreen`→`useScreen`), by `screen` tendency.
- **Spacing relocation:** shooters drift to the most-open arc spot (BMOS/PPCF "where to relocate"); bigs hold inside.

All expressed as the same Intent types, selected with continuity weights.

## Cut reads (PLOS ONE)

Trigger cuts by defender **depth toward the basket** (and its short-term change), not just denial distance:
- **backdoor** when the defender denies the lane *and* is shallow (overplaying high) → cut behind,
- **basket cut** when the lane is open (defender deep / helping),
- a cut "gets open" when the cutter beats the defender's depth (the `c`/`h` read).

## Screen-contact algorithm

**On-ball P&R:** the `ballScreen` screener navigates beside the handler's defender (existing pnr bringup→screen). Contact = a brief impede: when the screener is within ~2 ft of that defender, inflate the defender's steering danger through the screen (or a short "delayed" state) so the handler gets a step; coverage (switch/drop/hedge, existing defense) decides the result.

**Off-ball screens (down/flare/pin/floppy):** the `offScreen` screener moves between the target's defender and the target's destination; on contact, that defender is briefly impeded; the target (`useScreen`) picks curl/fade/straight from the defender's reaction (read) and the target's shooting tendency.

Screen contact is geometric (distance thresholds), deterministic.

## Integration & invariants

- **Builds on:** PR 6 spot tables + `isInsidePlayer`; rebounding convergence (post-shot positioning is its own intent set while the ball is in flight); `effectiveTendencies` (coaching biases play-calling + intent weights); `rng()`-only determinism.
- **Unchanged:** `offenseDecide` ball-handler logic and transitions.
- **Coordinator invariants:** one handler; ≤1 active ball-screen; ≥2 perimeter spacers (unless a set dictates); no two players targeting the same spot.

## Phasing (iterative — eyeball between phases via `npm run dev`)

1. **Macro-intent foundation + continuity** — intent model + per-player intent utility + coordinator + continuity rules (pass-and-cut, fill, screen-away), replacing ad-hoc `offBallMove`. *Eyeball: floor alive, organized, spaced.*
2. **Context Steering** — interest/danger heading selection + separation in `movement.ts` (ship separation-only first if risky). *Eyeball: smooth, no bunching, natural cuts.*
3. **Set plays + play-calling + UI** — the Play schema + starter playbook + play-calling policy + a play/gameplan picker in the React coaching panel. *Eyeball: recognizable sets execute.*

Each phase: deterministic, stat-sanity (FG% / 3PA / AST / TOV realistic), re-baseline goldens, structural tests + eyeball.

## Testing (feel is eyeballed; structure/determinism is tested)

- intents resolve to valid in-bounds targets; floor invariants hold (one ball-screen, spacing maintained);
- a called play executes its key positions (e.g., Horns: role 5 screens near the handler by beat 1);
- continuity: after a pass, a cut/relocation fires within N ticks (activity metric);
- cut reads: a cutter gets open more often vs a beaten/shallow defender;
- stat-sanity: assists rise (more movement) while FG% / 3PA / TOV stay realistic.

## Risks

- **Activity vs. stats:** PR 6 showed aggressive cutting wrecks pace/3PA — keep intent frequencies calibrated against the stat-sanity gate.
- **Context Steering is a movement-engine swap** (biggest risk) — phase separation-only first.
- **Screen physics can feel janky** — start simple (impede + step), refine by eyeball.
