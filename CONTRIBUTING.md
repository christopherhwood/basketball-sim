# Contributing

Contributions are very welcome — and that explicitly includes **vibe-coded, AI-assisted, and experimental** work. If you used Claude Code, Cursor, Copilot, or just hacked something together until it felt right, that's great. Rough-but-working beats polished-but-absent. We'll help refine it in review.

## Open a PR — don't file an issue

**Prefer a pull request over an issue whenever you reasonably can.** Found a bug? A PR with a failing test (or a fix) is worth more than a bug report. Have an idea? A scrappy PR that shows it beats a feature request. Issues are fine for genuinely open questions or things you can't attempt yourself, but the default here is: **show us in code.** A draft PR that doesn't fully work yet is completely fine — open it and say what you're stuck on.

## Quick start

```bash
npm install
npm run dev    # play it in the browser
npm test       # run the suite
npm run build  # typecheck + production build
npm run sim    # headless multi-game stat run (sanity-check engine changes)
```

Then branch, commit, push, and open a PR against `main`. CI runs typecheck + tests + build on every PR.

## A few things worth knowing

- **The simulation engine is pure and deterministic.** Everything under `src/core`, `src/sim`, `src/data`, `src/tactics` avoids the DOM and routes all randomness through the seeded generator in `src/core/rng.ts` (no raw `Math.random()`). `newGame(seed)` reproduces a game exactly. Please keep it that way — it's what makes the tests a reliable spec.
- **Some tests are golden digests.** If you intentionally change how the game plays, a couple of golden values (e.g. in `tests/game.test.ts`) will change — that's expected. Re-run `npm test`, update the golden numbers to the new deterministic output, and keep the invariant assertions intact. If a *behavioral* test breaks, the engine probably regressed.
- **`npm run sim`** prints aggregate box-score stats over many games — use it to confirm your change keeps the numbers realistic (turnovers, FG%, etc.).
- **Adding players/teams?** Keep roster JSON hosted separately from the game. You're welcome to generate your own players and teams (schema in `data/schema/`), but contributed rosters won't be bundled with the game.
- **Style:** TypeScript, strict mode, relative imports use `.js` extensions. Match the surrounding code; small, focused PRs are easiest to review.

## Where things are

See [`README.md`](./README.md) for the project layout and [`ROADMAP.md`](./ROADMAP.md) for what's planned. `CLAUDE.md` has an orientation guide for the codebase (handy whether or not you use an AI assistant).

Be kind in reviews. We're building something fun.
