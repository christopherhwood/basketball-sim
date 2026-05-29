# SIDELINE — basketball coaching sim

A tick-based basketball simulation focused on coaching: set your scheme, pick-and-roll
coverage, pressure, pace, and shot selection, then watch ten players react on the floor
in real time. World units are feet; the court is 94 × 50.

This started as a single prototype HTML file (`starter.html`, kept for provenance) and is
now a structured TypeScript project with a pure, deterministic simulation engine and a
spec-style test suite.

## Quick start

```bash
npm install
npm run dev        # Vite dev server — open the printed localhost URL
npm test           # run the full Vitest suite
npm run build      # typecheck + production build into dist/
npm run typecheck  # tsc --noEmit
npm run sim        # headless multi-game stat run (sanity-check the engine)
```

The app uses ES modules and must be served (it will not run from `file://`); use
`npm run dev`.

## Project layout

```
index.html            app shell (markup only)
src/
  main.ts             entry: game loop + UI wiring
  types.ts            shared engine types
  styles.css
  core/
    constants.ts      court geometry, DT
    rng.ts            seeded, portable mulberry32 generator
    math.ts           geometry + rng-backed rnd/chance/randn
    state.ts          the central game state G, newGame(), team accessors, logEv
  data/
    archetypes.ts     player archetype templates (attribute ranges)
    names.ts
    roster.ts         attribute generation (genPlayer / genTeam)
  tactics/
    tactics.ts        team-level gameplan (yours + the CPU's)
  sim/
    movement.ts       steering / integration
    offense.ts        utility-based offense AI + pick & roll + off-ball movement
    defense.ts        man / 2-3 zone + P&R coverage
    resolution.ts     shots, rebounds, fouls, free throws
    transition.ts     made-basket and live (steal/board) transitions
    possession.ts     possession setup, clocks, the tick() orchestrator
  render/
    render.ts         Canvas 2D court + players (presentation only)
  ui/
    ui.ts             scoreboard / box score / feed DOM updates
  data/
    playerData.ts     pure validate (ajv) + JSON-to-engine-player mapping
    loadFromFs.ts     node roster loader (sim + tests)
    leagueBrowser.ts  browser roster loader (Vite import.meta.glob)
scripts/
  sim.ts              headless multi-game stat harness
data/                 external roster JSON (teams/, optional free-agents.json, schema/)
.claude/skills/       generate-roster skill (LLM roster authoring)
tests/                Vitest spec + golden-vector suite
```

### Architecture principles

- **The engine is pure and framework-agnostic.** Nothing under `src/core`, `src/sim`,
  `src/data`, or `src/tactics` touches the DOM or canvas. Only `render.ts`, `ui.ts`, and
  the loop in `main.ts` do. This keeps the presentation layer swappable (a React UI is
  planned next; see `ROADMAP.md`).
- **The engine is seed-deterministic.** All randomness routes through `src/core/rng.ts`
  (a portable mulberry32). `newGame(seed)` reproduces an identical game. There is no raw
  `Math.random()` in the engine.

## Tests as a portable spec

The test suite is written so the engine could be re-implemented in another language from
the tests alone. It pins down exact formulas and thresholds and bakes in **golden
vectors** — fixed-seed RNG sequences, generated rosters, and a multi-tick simulation
digest (see `tests/game.test.ts`). Because the RNG is portable, a faithful port that
consumes the random stream in the same order will reproduce the same golden numbers.

## Headless sim

`npm run sim` plays full games with no rendering and prints aggregate box-score numbers
(per-game points, FG/3P/FT splits, rebounds, assists, steals, turnovers, blocks, estimated
possessions, and points per possession). It is the fast way to sanity-check the statistical
output whenever you change engine logic.

```bash
npm run sim                  # 100 games, base seed 1
npm run sim -- --games 500   # more games for tighter averages
npm run sim -- --seed 42     # different base seed (games are seeded base+i)
npm run sim -- --home harbor-city-wolves --away summit-valley-rampart  # fixed rosters
```

## Player data

Rosters can be authored as external JSON and dropped into `data/` — no code changes
needed. The game auto-discovers `data/teams/*.json` (the first two teams are used as the
matchup for now) and an optional `data/free-agents.json` (omit it entirely for college or
high-school leagues). Files are validated against `data/schema/*.json` on load. If `data/`
is empty, the game falls back to archetype generation, so it still runs out of the box.

Player JSON carries identity, the 25–99 `attributes`, and 0–100 `tendencies` (which the
per-player AI in a later PR will consume). See `data/README.md` for the format and
attribute scale.

A bundled Claude Code skill, **`generate-roster`** (`.claude/skills/generate-roster/`),
teaches Claude to research public statistics and emit valid roster JSON — so realistic
NBA/college teams can be generated and dropped straight in.

## Where this is going

The north star is a 2K-depth coaching sim: individual player attributes **and**
tendencies, per-player decision-making each tick, coaching applied per-player and
per-matchup, and LLM-friendly JSON player data so realistic rosters can be generated from
public statistics. See [`ROADMAP.md`](./ROADMAP.md).
