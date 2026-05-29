# Roster data

This directory holds the rosters the game plays with. Everything here is plain JSON, so
you can author teams by hand, generate them with a tool, or have Claude Code build them
from public stats — no code changes required.

## Directory layout

```
data/
  teams/                     one JSON file per team
    harbor-city-wolves.json
    summit-valley-rampart.json
  free-agents.json           optional pool of unsigned players
  schema/                    JSON Schemas the files are validated against
    player.schema.json
    team.schema.json
    free-agents.schema.json
```

- **`data/teams/*.json`** — each file is one team. Drop a file in here and the game picks
  it up automatically: in dev, Vite hot-reloads so a new or edited file appears without a
  restart. The first two teams (sorted by filename) are used as the matchup.
- **`data/free-agents.json`** — optional. A pool of unsigned players. If you delete this
  file entirely, the game still runs fine — handy for college or high-school leagues that
  have no free-agent concept.
- **`data/schema/`** — the JSON Schemas. Files are validated against these on load, so a
  typo or out-of-range rating is caught with a clear error instead of silently breaking a
  game. The schema you author against is [`schema/player.schema.json`](schema/player.schema.json).

If no team files are present at all, the game falls back to its built-in archetype roster
generator, so it always has something to play.

## Authoring a player

Every player in a team file (and in `free-agents.json`) is the same shape, defined by
[`schema/player.schema.json`](schema/player.schema.json):

```json
{
  "name": "Marcus Bell",
  "number": 3,
  "position": "PG",
  "height": 6.2,
  "attributes": { "speed": 88, "handleRight": 90, "handleLeft": 74, "weight": 190, "...": "all 16 ratings" },
  "tendencies": { "shootThree": 60, "pass": 85, "...": "all 10 tendencies" }
}
```

- **`name`** — display name.
- **`number`** — jersey number, `0..99`. Keep these unique within a team.
- **`position`** — one of `PG`, `SG`, `SF`, `PF`, `C`.
- **`height`** — in feet, as a decimal. A 6-foot-9 player is `6.75`; a 7-footer is `7.0`.
  Use realistic heights for the position.
- **`attributes`** — the 16 ratings below.
- **`tendencies`** — the 10 tendencies below.

### Attributes (the 16 ratings)

`speed`, `handleLeft`, `handleRight`, `pass`, `three`, `mid`, `finishing`, `perimD`,
`steal`, `iq`, `strength`, `weight`, `vertical`, `rebound`, `interiorD`, `block`.

Every attribute except `weight` is an integer on this scale:

| Range  | Meaning              |
| ------ | -------------------- |
| 25     | weak                 |
| ~50    | rotation player      |
| ~75    | good starter         |
| 85+    | all-star             |
| 95+    | elite                |

Make the ratings fit the player. A rim-running center should be high on `finishing`,
`rebound`, `interiorD`, `block`, and `strength`, and low on `three` and ball-handling. A
sharpshooter should be high on `three` (and on the `shootThree` tendency below).

**`handleLeft` / `handleRight`** — handedness. Each is the player's ball-handling skill
with that hand (25..99). The **higher of the two is the strong hand**; the other is the
weak hand. Most players are right-dominant (`handleRight` higher), with a few lefties.
A typical weak hand sits roughly 15-22 below the strong hand. Forcing a player to drive
to his weak hand will hurt his ball-handling; right now the engine simply uses the
stronger hand for default ball-handling.

**`weight`** — in **pounds** (~150-330), not a 25..99 rating. It matters for **physical
play**: heavier players hold position in rebounding battles and have an edge in post-ups.
Use realistic weights for the position (guards ~175-205, wings ~210-235, bigs ~250-300).

### Tendencies (the 10 behaviors)

`shootThree`, `shootMid`, `driveRim`, `pass`, `postUp`, `screen`, `helpDefense`,
`gambleSteal`, `crashGlass`, `pushTransition`.

Each tendency is an integer `0..100` describing **how often** the player does that thing —
`0` never, `100` constantly. Tendencies are about choices, attributes are about skill: a
player can have a high `three` rating (good shooter) but a low `shootThree` tendency
(rarely takes the shot), or the reverse.

## Generating rosters with Claude Code

The **`generate-roster`** Claude Code skill produces schema-valid team and free-agent files
from public stats. Ask it for a team and it will research the players, map their real-world
stats onto this attribute and tendency scale, and write a validated file into
`data/teams/`. The included `harbor-city-wolves.json` and `summit-valley-rampart.json` are
hand-built fictional examples that show the format and exercise a full 8-player rotation.
