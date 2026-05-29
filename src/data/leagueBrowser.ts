import { validateTeamData, validateFreeAgentsData } from "./playerData.js";
import type { PlayerData, TeamData } from "../types.js";

export function loadLeagueFromGlob(): { teams: TeamData[]; freeAgents: PlayerData[] } {
  const teamModules = import.meta.glob<unknown>("/data/teams/*.json", { eager: true, import: "default" });
  const teams: TeamData[] = Object.keys(teamModules)
    .sort()
    .map((path) => validateTeamData(teamModules[path], path));

  const faModules = import.meta.glob<unknown>("/data/free-agents.json", { eager: true, import: "default" });
  let freeAgents: PlayerData[] = [];
  for (const path of Object.keys(faModules)) {
    freeAgents = validateFreeAgentsData(faModules[path], path).players;
  }

  return { teams, freeAgents };
}
