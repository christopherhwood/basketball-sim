import { G } from "../core/state.js";
import { useGameVersion } from "../app/useGame.js";

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
}

export function Scoreboard(): React.JSX.Element {
  useGameVersion();
  return (
    <div className="scorebar">
      <div className="home">
        <div className="team" id="homeName">YOU</div>
        <div className="pts" id="homePts">{G.score.home}</div>
      </div>
      <div className="clock">
        <div className="q" id="qLbl">{G.over ? "FINAL" : "Q" + G.quarter}</div>
        <div className="gc" id="gameClock">{fmtClock(G.gameClock)}</div>
        <div className="sc" id="shotClock">{":" + String(Math.ceil(G.shotClock)).padStart(2, "0")}</div>
      </div>
      <div className="away" style={{ textAlign: "right" }}>
        <div className="team" id="awayName">CPU</div>
        <div className="pts" id="awayPts">{G.score.away}</div>
      </div>
    </div>
  );
}
