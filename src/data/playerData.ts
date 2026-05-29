import Ajv, { type ValidateFunction } from "ajv/dist/2020.js";
import { clamp } from "../core/math.js";
import playerSchema from "../../data/schema/player.schema.json" with { type: "json" };
import teamSchema from "../../data/schema/team.schema.json" with { type: "json" };
import freeAgentsSchema from "../../data/schema/free-agents.schema.json" with { type: "json" };
import type { Attributes, Player, PlayerData, TeamData, FreeAgentData, TeamSide } from "../types.js";

const ajv = new Ajv();
ajv.addSchema([playerSchema, teamSchema, freeAgentsSchema]);

const validateTeam = ajv.getSchema("https://bball.local/schema/team.schema.json") as ValidateFunction<TeamData>;
const validateFreeAgents = ajv.getSchema("https://bball.local/schema/free-agents.schema.json") as ValidateFunction<FreeAgentData>;

function fail(validate: ValidateFunction, sourceLabel: string): never {
  const text = ajv.errorsText(validate.errors, { separator: "; " });
  throw new Error(`invalid data in ${sourceLabel}: ${text}`);
}

export function validateTeamData(obj: unknown, sourceLabel: string): TeamData {
  if (!validateTeam(obj)) fail(validateTeam, sourceLabel);
  return obj;
}

export function validateFreeAgentsData(obj: unknown, sourceLabel: string): FreeAgentData {
  if (!validateFreeAgents(obj)) fail(validateFreeAgents, sourceLabel);
  return obj;
}

function zeroStats(): Player["stats"] {
  return { pts: 0, fga: 0, fgm: 0, tpa: 0, tpm: 0, rimFga: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fta: 0, ftm: 0 };
}

export function toEnginePlayer(pd: PlayerData, team: TeamSide): Player {
  const attr: Attributes = {
    ...pd.attributes,
    height: pd.height,
    tendShoot: clamp(0.3 + ((pd.tendencies.shootThree + pd.tendencies.shootMid) / 2 / 100) * 0.6, 0.3, 0.9),
  };
  return {
    team,
    num: pd.number,
    pos: pd.position,
    arch: "custom",
    attr,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    hasBall: false,
    fatigue: 0,
    target: null,
    role: "spacer",
    assign: null,
    stats: zeroStats(),
    name: pd.name,
    tendencies: { ...pd.tendencies },
  };
}

// Maps the first 5 players of a team to engine Players. Substitutes (any beyond
// the first 5) are out of scope here and handled by a later PR.
export function teamToEnginePlayers(team: TeamData, side: TeamSide): Player[] {
  return team.players.slice(0, 5).map((pd) => toEnginePlayer(pd, side));
}
