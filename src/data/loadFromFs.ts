import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateTeamData, validateFreeAgentsData } from "./playerData.js";
import type { PlayerData, TeamData } from "../types.js";

export function loadLeagueFromDir(dir = "data"): { teams: TeamData[]; freeAgents: PlayerData[] } {
  const teamsDir = join(dir, "teams");
  const teams: TeamData[] = [];
  if (existsSync(teamsDir)) {
    const files = readdirSync(teamsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files) {
      const path = join(teamsDir, f);
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      teams.push(validateTeamData(raw, path));
    }
  }

  let freeAgents: PlayerData[] = [];
  const faPath = join(dir, "free-agents.json");
  if (existsSync(faPath)) {
    const raw = JSON.parse(readFileSync(faPath, "utf8")) as unknown;
    freeAgents = validateFreeAgentsData(raw, faPath).players;
  }

  return { teams, freeAgents };
}
