---
name: generate-roster
description: Generate or edit basketball player/team roster JSON for the sim from public stats. Use when the user wants to create a team, add players, build a league, or convert real NBA/college/high-school players into game data.
---

# Generate Roster JSON

Author realistic team and free-agent JSON for the basketball sim from public
statistics (NBA, college, high-school, or made-up). The engine loads these files
from `data/teams/` and `data/free-agents.json` and converts them into engine
players. The JSON Schema in `data/schema/` is the source of truth — every file
must validate against it.

## 1. Read the schema and any existing samples first

Always start by reading these so the output matches the current contract exactly:

- `data/schema/player.schema.json` — the per-player shape (16 attributes, 10
  tendencies, name/number/position/height). This is the source of truth.
- `data/schema/team.schema.json` — team shape (`id`, `name`, `abbrev`, `players`;
  `id` is kebab-case, `abbrev` is 2..4 chars, at least 5 players).
- `data/schema/free-agents.schema.json` — free-agent pool shape (`{ "players": [...] }`).
- Any files already in `data/teams/` — copy their formatting and rating altitude
  so a new team is calibrated against the existing league.

Key constraints to respect (the schema rejects anything else):
- All `attributes` are integers **25..99**, except `weight` which is an integer
  **150..330** (pounds).
- All 10 `tendencies` are integers **0..100**.
- `position` is one of `PG`, `SG`, `SF`, `PF`, `C`.
- `height` is in **feet** (e.g. `6.75` for 6'9"), range 5.5..7.6.
- `number` is an integer 0..99.
- Author the `attributes` object with the **16 ratings only** — do NOT put
  `height` or `tendShoot` inside `attributes`. The loader supplies `attr.height`
  from the top-level `height` and computes `tendShoot` from the shoot tendencies.
- Ball-handling is split into `handleLeft` and `handleRight` (handedness). The
  **higher of the two is the strong hand**; give most players a higher
  `handleRight` (right-dominant) and a few a higher `handleLeft` (lefties). The
  weak hand typically sits ~15-22 below the strong hand. The engine uses the
  stronger hand for default ball-handling; forcing a player to his weak hand
  hurts.
- `weight` is in **pounds** (~150-330), not a 25..99 rating. It matters for
  physical play: rebounding (heavier players hold position) and post-ups. Use
  realistic weights by position.

## 2. Rating and tendency scales

**Ratings (25..99)** are relative within the league, not absolute:

| Rating | Meaning |
| --- | --- |
| ~25 | weak / liability at this skill |
| ~50 | rotation-level / NBA average |
| ~75 | good starter |
| 85+ | all-star caliber |
| 95+ | elite, best in the league at it |

**Tendencies (0..100)** are *frequency*, not skill: how often the player tries a
thing. A great shooter who rarely shoots has high `three` but low `shootThree`.

Calibrate ratings against the rest of the league. If every player on a team is
85+, nobody is. Spread your bench down toward 40-55.

### Mapping heuristics from public stats

Use these as starting points, then sanity-check for internal consistency:

- **Shooting → `three` / `mid` / `finishing`**
  - 3P% plus volume → `three`. ~40% on real volume → 85+; ~37% → ~70; ~33% → ~50;
    rarely shoots / poor → 30-45.
  - Mid-range / pull-up effectiveness → `mid`.
  - Rim FG% and dunk frequency → `finishing` (also bump with `vertical`/`strength`).
- **Shot diet → `shootThree` / `shootMid` / `driveRim` tendencies**
  - 3PA rate (3PA / FGA) → `shootThree`. A high-volume shooter (~9+ 3PA) → 70-90;
    a center who never shoots → 0-15.
  - Drive frequency / drives-per-game / rim attempt rate → `driveRim`.
- **Scoring load → overall tendency balance**
  - PPG and **usage rate** drive how aggressive the tendency profile is. High-usage
    creators get elevated `shootThree`/`shootMid`/`driveRim`; low-usage role players
    lean to `pass`, `screen`, `crashGlass`.
- **Playmaking → `pass` rating + `pass` tendency**
  - AST per game and AST% → both the `pass` rating (skill) and `pass` tendency
    (how often they look to set up others). High AST, low usage → high `pass`
    tendency relative to shooting.
  - `handleLeft` / `handleRight` ← turnover-light high-usage ball handling,
    dribble creation; set the dominant hand higher (most players right-dominant,
    a few lefties) with the weak hand ~15-22 lower.
  - `speed` ← athleticism, transition involvement, end-to-end quickness.
- **Defense → `steal` / `block` / `perimD` / `interiorD`**
  - STL per game / STL% → `steal` rating and `gambleSteal` tendency.
  - BLK per game / BLK% → `block` rating.
  - Defensive rating (DRTG), DBPM, position, and reputation → `perimD` (guards/wings)
    and `interiorD` (bigs). Lower DRTG = better → higher D ratings.
- **Rebounding → `rebound`** from TRB (and ORB/DRB) per game **scaled by height and
  position**. A 6'2" guard with 5 TRB is a strong rebounding guard (~70); a 6'11"
  center with 5 TRB is mediocre (~55).
- **Size → `strength` / `weight` / `vertical` / `height`**
  - `strength` ← post defense, physicality, ability to hold position.
  - `weight` ← listed playing weight in **pounds** (~150-330). Drives rebounding
    and post-ups along with `strength`. Guards ~175-205, wings ~210-235, bigs
    ~250-300.
  - `vertical` ← dunks, blocks, putbacks, athletic reputation.
- **Position + role → `driveRim` / `postUp` / `screen` tendencies**
  - Slashing guards/wings → high `driveRim`, low `postUp`.
  - Back-to-the-basket bigs → high `postUp`, high `screen`.
  - Pick-setting bigs and screen-heavy roles → high `screen`.
- **Effort / role → `crashGlass` / `helpDefense` / `gambleSteal`**
  - ORB rate and motor → `crashGlass`.
  - Help/anchor reputation, DRTG, block rate → `helpDefense`.
  - Steal-gambling, deflections, foul-prone aggressive D → `gambleSteal`.
- **Team pace → `pushTransition`**
  - Faster team / high transition frequency → higher `pushTransition` across the
    roster; deliberate half-court teams lower it.

Internal consistency matters more than any single stat. A 5'10" rim-finishing
center makes no sense; a 99-`three` player who is a 5-`shootThree` should be rare
and intentional.

## 3. Write the files

- Teams go to `data/teams/<kebab-id>.json` where the filename matches the `id`
  field (e.g. `data/teams/golden-state.json` with `"id": "golden-state"`).
- Use the `TeamData` shape: `{ id, name, abbrev, players: [...] }`, at least 5
  players (author a realistic 8-12 player rotation when you have the data).
- Free agents are **optional**: write `data/free-agents.json` (a single
  `{ "players": [...] }` object) only for pro-style leagues. **Skip free agents
  for college and high-school leagues** — there is no free agency there.

## 4. Validate before finishing

Always validate the generated JSON. Do not skip this.

- Preferred: run the data tests, which validate every file in `data/` against the
  schema:

  ```sh
  npm test
  ```

- If you only want a quick load-and-play smoke check (when the sim runner supports
  team selection), run:

  ```sh
  npm run sim -- --home <home-id> --away <away-id>
  ```

If validation fails, read the AJV error, fix the offending field (usually an
out-of-range integer, a stray `height`/`tendShoot` inside `attributes`, a bad
`position`, an `id`/filename mismatch, or fewer than 5 players), and re-run.

## 5. Cite sources

List the public sources used for the stats (e.g. Basketball-Reference,
NBA.com/stats, Sports-Reference college, a school's box scores) so the ratings are
traceable and re-derivable. A short list at the end is enough.

## Minimal example team

`data/teams/example-five.json`:

```json
{
  "id": "example-five",
  "name": "Example Five",
  "abbrev": "EX5",
  "players": [
    {
      "name": "Point Guard",
      "number": 3,
      "position": "PG",
      "height": 6.25,
      "attributes": {
        "speed": 82, "handleRight": 85, "handleLeft": 67, "pass": 84, "three": 78,
        "mid": 72, "finishing": 70, "perimD": 68, "steal": 72, "iq": 80,
        "strength": 55, "weight": 190, "vertical": 65, "rebound": 45,
        "interiorD": 45, "block": 35
      },
      "tendencies": {
        "shootThree": 55, "shootMid": 35, "driveRim": 60, "pass": 80,
        "postUp": 5, "screen": 10, "helpDefense": 45, "gambleSteal": 50,
        "crashGlass": 20, "pushTransition": 70
      }
    },
    {
      "name": "Shooting Guard",
      "number": 22,
      "position": "SG",
      "height": 6.5,
      "attributes": {
        "speed": 76, "handleRight": 70, "handleLeft": 52, "pass": 60, "three": 88,
        "mid": 75, "finishing": 68, "perimD": 70, "steal": 66, "iq": 70,
        "strength": 60, "weight": 205, "vertical": 70, "rebound": 48,
        "interiorD": 48, "block": 40
      },
      "tendencies": {
        "shootThree": 75, "shootMid": 45, "driveRim": 40, "pass": 45,
        "postUp": 8, "screen": 12, "helpDefense": 50, "gambleSteal": 45,
        "crashGlass": 25, "pushTransition": 60
      }
    },
    {
      "name": "Small Forward",
      "number": 7,
      "position": "SF",
      "height": 6.75,
      "attributes": {
        "speed": 74, "handleRight": 68, "handleLeft": 50, "pass": 66, "three": 74,
        "mid": 70, "finishing": 78, "perimD": 78, "steal": 68, "iq": 72,
        "strength": 70, "weight": 225, "vertical": 78, "rebound": 62,
        "interiorD": 62, "block": 55
      },
      "tendencies": {
        "shootThree": 50, "shootMid": 35, "driveRim": 55, "pass": 50,
        "postUp": 20, "screen": 20, "helpDefense": 65, "gambleSteal": 50,
        "crashGlass": 45, "pushTransition": 55
      }
    },
    {
      "name": "Power Forward",
      "number": 41,
      "position": "PF",
      "height": 6.83,
      "attributes": {
        "speed": 62, "handleRight": 55, "handleLeft": 38, "pass": 58, "three": 60,
        "mid": 62, "finishing": 80, "perimD": 62, "steal": 55, "iq": 68,
        "strength": 82, "weight": 250, "vertical": 75, "rebound": 80,
        "interiorD": 78, "block": 70
      },
      "tendencies": {
        "shootThree": 30, "shootMid": 35, "driveRim": 45, "pass": 40,
        "postUp": 45, "screen": 55, "helpDefense": 70, "gambleSteal": 35,
        "crashGlass": 70, "pushTransition": 40
      }
    },
    {
      "name": "Center",
      "number": 33,
      "position": "C",
      "height": 7.0,
      "attributes": {
        "speed": 52, "handleRight": 45, "handleLeft": 30, "pass": 52, "three": 32,
        "mid": 50, "finishing": 84, "perimD": 50, "steal": 48, "iq": 66,
        "strength": 88, "weight": 285, "vertical": 74, "rebound": 88,
        "interiorD": 86, "block": 84
      },
      "tendencies": {
        "shootThree": 5, "shootMid": 20, "driveRim": 40, "pass": 35,
        "postUp": 65, "screen": 70, "helpDefense": 80, "gambleSteal": 25,
        "crashGlass": 80, "pushTransition": 25
      }
    }
  ]
}
```
