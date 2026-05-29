import { createRoot } from "react-dom/client";
import { App } from "./ui/App.js";
import { newMatchup } from "./app/engine.js";
import { loadLeagueFromGlob } from "./data/leagueBrowser.js";
import { buildRosters, setCurrentRosters, setSelection, GENERATED } from "./app/matchup.js";

// Initialize the game state before the first React render: components read the
// live G synchronously while rendering, so G must exist before render().
const { teams } = loadLeagueFromGlob();
const selection =
  teams.length >= 2 ? { home: teams[0].id, away: teams[1].id } : { home: GENERATED, away: GENERATED };
const rosters = buildRosters(selection, teams);
setSelection(selection);
setCurrentRosters(rosters);
newMatchup(rosters);

createRoot(document.getElementById("root")!).render(<App />);
