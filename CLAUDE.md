# CLAUDE.md

Orientation for the SIDELINE basketball-sim codebase — useful for any contributor, and written so an AI assistant (Claude Code, etc.) can get productive quickly.

## What this is

A tick-based basketball coaching simulation. A pure TypeScript engine advances the game 0.1s at a time; a React + Canvas UI renders it and lets you set tactics and per-player coaching. World units are feet; the court is 94 × 50.

## Architecture (the one rule that matters most)

**The simulation engine is pure, deterministic, and framework-agnostic.** Keep it that way:

- **No DOM / canvas / React** under `src/core`, `src/sim`, `src/data`, `src/tactics`. Only `src/render`, `src/ui`, and `src/app` touch the browser.
- **All randomness routes through `src/core/rng.ts`** — a seeded, portable mulberry32 generator. Use `rng()`/`rnd()`/`chance()`/`randn()` from `src/core/math.ts`; never `Math.random()` in the engine. `newGame(seed)` reproduces a game exactly.
- This is what makes the test suite a reliable spec and lets the engine be re-implemented in another language from the tests alone.

## Decisions live in the players (the north star)

Push **all** decision-making into the individual players, decided **per-tick** from each
player's own read of the floor (his utility deciders), plus his attributes / tendencies /
coaching. Coordination happens through shared reference points (e.g. a screen "call"), not
central control. Concretely:

- **No central scripts or state-machines deciding behavior** for a player. A player isn't
  "put into" a committed multi-tick action that runs to a fixed end — he re-evaluates and
  chooses to continue or change each tick. (e.g. a roller decides when the dive is spent
  and he should post/relocate; he isn't stopped by a hardcoded timer/distance.)
- **No hardcoded magic timers / thresholds for behavior.** "How long to hold a screen",
  "when to stop rolling", "when to give up a cut" — these are the **player's** decision and
  should be **player-dependent** (derived from his IQ / relevant tendency / the live read),
  not a global constant the same for everyone. The vast majority of the tuning constants
  scattered through `src/sim` are debt against this rule; prefer replacing them with a
  per-player read when you touch them, and don't add new ones.
- Physical/scoring math (contact, make probability, RNG draws) stays shared; it's the
  *decisions* (what to do, and when to stop doing it) that belong to the player.

## Layout

```
src/
  core/      constants, rng, math, state (the central mutable `G`)
  data/      archetypes, roster generation, JSON player-data loader (ajv-validated)
  tactics/   team-level gameplan
  sim/       the engine: movement, offense, defense, resolution, transition,
             possession (the tick() orchestrator), tendency resolver
  coaching/  per-player coaching model + resolver
  render/    Canvas-2D court (createRenderer(canvas))
  app/       game-loop controller + a tiny store (useSyncExternalStore bridge)
  ui/        React components (App, Court, Scoreboard, BoxScore, Tactics, Coaching, ...)
data/        external roster JSON (teams/, optional free-agents.json, schema/)
scripts/     sim.ts — headless multi-game stat harness
tests/       Vitest spec + golden-vector suite
.claude/skills/  generate-roster (LLM roster authoring)
```

## How it runs

- `G` (in `src/core/state.ts`) is the single mutable game state. `tick()` (in `src/sim/possession.ts`) advances one step: it runs the offense/defense decisions, resolves shots/rebounds/fouls, and manages clocks, transitions, and possessions.
- The React UI never owns game state — it reads `G` after a store `notify()` (driven by the loop each frame) via `useGameVersion()`. The game loop lives in `src/app/engine.ts`.
- **Players** have `attr` (rating-based abilities) and `tendencies` (how often they do things, 0–100). Decisions are utility-scored and modulated by tendencies; **coaching** adjusts a player's *effective* tendencies (neutral coaching = no change).

## Commands

```bash
npm run dev        # Vite dev server (the app must be served; it won't run from file://)
npm test           # Vitest suite
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build
npm run sim        # headless multi-game box-score stats
```

## Conventions

- Strict TypeScript; explicit types. Relative imports use `.js` extensions (e.g. `from "../core/math.js"`).
- Behavior changes that shift the deterministic output will break **golden digest** tests (e.g. `tests/game.test.ts`). That's expected: re-run, update the golden numbers, and keep the invariant assertions. A broken *behavioral/statistical* test usually means a real regression.
- Use `npm run sim` to confirm a change keeps box-score numbers realistic.
- No temporal/narration comments (avoid "now we…" / "this used to…").

## Where it's going

See [`ROADMAP.md`](./ROADMAP.md). North star: NBA-2K-depth coaching — per-player attributes and tendencies, per-tick individual decisions, coaching per-player and per-matchup, all on LLM-generatable JSON rosters.
