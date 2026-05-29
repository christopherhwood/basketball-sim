import { useMemo, useSyncExternalStore } from "react";
import { newMatchup } from "../app/engine.js";
import {
  buildRosters,
  getSelection,
  setCurrentRosters,
  setSelection,
  subscribeSelection,
  GENERATED,
  type MatchupSelection,
} from "../app/matchup.js";
import { loadLeagueFromGlob } from "../data/leagueBrowser.js";

export function MatchupSelect(): React.JSX.Element {
  const { teams, freeAgents } = useMemo(() => loadLeagueFromGlob(), []);
  const selection = useSyncExternalStore(subscribeSelection, getSelection);

  const applySide = (side: "home" | "away", value: string): void => {
    const next: MatchupSelection = { ...selection, [side]: value };
    const rosters = buildRosters(next, teams);
    setSelection(next);
    setCurrentRosters(rosters);
    newMatchup(rosters);
  };

  return (
    <div className="card">
      <h2>Matchup</h2>
      <div className="seg">
        <label htmlFor="matchup-home">home</label>
        <select id="matchup-home" value={selection.home} onChange={(e) => applySide("home", e.target.value)}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          <option value={GENERATED}>Random (generated)</option>
        </select>
      </div>
      <div className="seg">
        <label htmlFor="matchup-away">away</label>
        <select id="matchup-away" value={selection.away} onChange={(e) => applySide("away", e.target.value)}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
          <option value={GENERATED}>Random (generated)</option>
        </select>
      </div>
      {freeAgents.length > 0 && <p className="hint">{freeAgents.length} free agents available</p>}
    </div>
  );
}
