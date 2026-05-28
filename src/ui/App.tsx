import { useEffect } from "react";
import { startLoop, stopLoop, newMatchup } from "../app/engine.js";
import { loadLeagueFromGlob } from "../data/leagueBrowser.js";
import { buildRosters, setCurrentRosters, setSelection, GENERATED } from "../app/matchup.js";
import { Scoreboard } from "./Scoreboard.js";
import { Court } from "./Court.js";
import { Controls } from "./Controls.js";
import { BoxScore } from "./BoxScore.js";
import { MatchupSelect } from "./MatchupSelect.js";
import { TacticsPanel } from "./TacticsPanel.js";
import { PlayByPlay } from "./PlayByPlay.js";

export function App(): React.JSX.Element {
  useEffect(() => {
    const { teams } = loadLeagueFromGlob();
    const sel =
      teams.length >= 2
        ? { home: teams[0].id, away: teams[1].id }
        : { home: GENERATED, away: GENERATED };
    const rosters = buildRosters(sel, teams);
    setSelection(sel);
    setCurrentRosters(rosters);
    newMatchup(rosters);
    startLoop();
    return () => stopLoop();
  }, []);

  return (
    <div className="wrap">
      <header>
        <h1>SIDELINE</h1>
        <span className="tag">basketball coaching sim · v0.1</span>
      </header>

      <div className="grid">
        {/* LEFT: court + score + box */}
        <div>
          <div className="court-card">
            <Scoreboard />
            <Court />
            <Controls />
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <h2>Box score</h2>
            <BoxScore />
          </div>
        </div>

        {/* RIGHT: tactics + feed */}
        <div className="side">
          <MatchupSelect />
          <TacticsPanel />

          <div className="card">
            <h2>Play-by-play</h2>
            <PlayByPlay />
          </div>

          <div className="card">
            <h2>Read me</h2>
            <p className="hint">
              Watch a possession, then flip P&amp;R coverage between drop and switch and run it again. With drop,
              your big sinks to the paint and the opposing guard gets open mid-range pull-ups. With switch, the
              screener&apos;s man takes the ball and you give up mismatches but no clean jumper. The dots are
              reacting to your settings in real time.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
