import { teamToEnginePlayers } from "../data/playerData.js";
import type { Player, TeamData } from "../types.js";

export const GENERATED = "__generated__";

export type MatchupSelection = {
  home: string | typeof GENERATED;
  away: string | typeof GENERATED;
};

let currentRosters: { home: Player[]; away: Player[] } | undefined;

export function setCurrentRosters(rosters: { home: Player[]; away: Player[] } | undefined): void {
  currentRosters = rosters;
}

export function getCurrentRosters(): { home: Player[]; away: Player[] } | undefined {
  return currentRosters;
}

type SelectionListener = () => void;

let currentSelection: MatchupSelection = { home: GENERATED, away: GENERATED };
const selectionListeners = new Set<SelectionListener>();

export function getSelection(): MatchupSelection {
  return currentSelection;
}

export function setSelection(sel: MatchupSelection): void {
  currentSelection = sel;
  for (const cb of selectionListeners) cb();
}

export function subscribeSelection(cb: SelectionListener): () => void {
  selectionListeners.add(cb);
  return () => selectionListeners.delete(cb);
}

export function buildRosters(
  sel: MatchupSelection,
  teams: TeamData[],
): { home: Player[]; away: Player[] } | undefined {
  if (sel.home === GENERATED || sel.away === GENERATED) return undefined;
  const homeTeam = teams.find((t) => t.id === sel.home);
  if (!homeTeam) throw new Error(`team not found: ${sel.home}`);
  const awayTeam = teams.find((t) => t.id === sel.away);
  if (!awayTeam) throw new Error(`team not found: ${sel.away}`);
  return {
    home: teamToEnginePlayers(homeTeam, "home"),
    away: teamToEnginePlayers(awayTeam, "away"),
  };
}
