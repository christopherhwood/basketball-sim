# Simulation Calibration

The engine should stay deterministic and rules-based, but its tuning constants
should be treated like model parameters instead of scattered trivia.

## Why This Is Not A Full ML Rewrite

Randomness is expected in a sports sim: it creates game-to-game variance while
the seeded PRNG keeps every run reproducible. The fragile part is not the random
draws; it is hand-adjusting many interacting coefficients without a measurement
loop.

For now, the right compromise is:

- keep explicit basketball rules and readable decision code;
- expose important coefficients as bounded tunables;
- run many seeded games in neutral conditions;
- score aggregate metrics against broad NBA-like targets;
- use deterministic search to suggest better parameter sets.

Learned submodels can come later where data and payoff justify them: shot make
probability, foul probability, rebound winner, pass-risk/turnover probability,
or shoot/pass/drive choice. Those should remain swappable submodels rather than
replacing the whole engine.

## Workflow

1. Run a neutral baseline:

   ```bash
   npm run sim -- --home harbor-city-wolves --away summit-valley-rampart --neutral-tactics --swap
   ```

2. Run a small calibration search:

   ```bash
   npm run calibrate -- --home harbor-city-wolves --away summit-valley-rampart --games 20 --iterations 30 --out /tmp/candidate.json
   ```

3. Inspect the output:

   - `bestLoss` says how far the candidate is from the target profile.
   - `topLossTerms` shows the metrics driving the miss.
   - `bestParams` is a proposed parameter set, not an automatic code change.

4. Promote a candidate only after a larger validation run and tests:

   ```bash
   npm run sim -- --games 500 --neutral-tactics --tunables /tmp/candidate.json
   npm run sim -- --games 500 --neutral-tactics --json
   npm test
   ```

## Target Profiles

Profiles live under `data/calibration/`. The v1 NBA-like profile uses broad
ranges rather than exact season averages so it catches obvious drift without
overfitting one data source or roster pair.

Golden tests still protect deterministic replay. Calibration metrics protect
statistical behavior.

## V1 Calibrated Defaults

The first promoted parameter set is intentionally small:

- `shooting.contestScale = 0.80`
- `turnovers.onBallScale = 0.65`
- `turnovers.badPassScale = 0.65`
- `turnovers.laneStealScale = 0.75`

This keeps neutral side bias low while moving generated-roster games toward
NBA-like pace, efficiency, turnover rate, and steal rate. Blocks and assist rate
remain separate follow-up tuning problems.
