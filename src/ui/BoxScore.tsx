import type { Player } from "../types.js";
import { G } from "../core/state.js";
import { useGameVersion } from "../app/useGame.js";

function row(p: Player): React.JSX.Element {
  const s = p.stats;
  return (
    <tr key={`${p.num}-${p.name}`}>
      <td className="name">{`${p.num} ${p.name}`}</td>
      <td>{s.pts}</td>
      <td>{`${s.fgm}-${s.fga}`}</td>
      <td>{`${s.tpm}-${s.tpa}`}</td>
      <td>{`${s.ftm}-${s.fta}`}</td>
      <td>{s.reb}</td>
      <td>{s.ast}</td>
      <td>{s.stl}</td>
      <td>{s.tov}</td>
    </tr>
  );
}

export function BoxScore(): React.JSX.Element {
  useGameVersion();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
      <div>
        <div style={{ color: "var(--home)", fontSize: "11px", letterSpacing: ".1em", marginBottom: "4px" }}>
          YOUR TEAM
        </div>
        <table className="home-tbl">
          <thead>
            <tr>
              <th className="name">PLAYER</th>
              <th>PTS</th>
              <th>FG</th>
              <th>3P</th>
              <th>FT</th>
              <th>REB</th>
              <th>AST</th>
              <th>STL</th>
              <th>TO</th>
            </tr>
          </thead>
          <tbody id="homeBox">{G.home.map(row)}</tbody>
        </table>
      </div>
      <div>
        <div style={{ color: "var(--away)", fontSize: "11px", letterSpacing: ".1em", marginBottom: "4px" }}>
          OPPONENT
        </div>
        <table className="away-tbl">
          <thead>
            <tr>
              <th className="name">PLAYER</th>
              <th>PTS</th>
              <th>FG</th>
              <th>3P</th>
              <th>FT</th>
              <th>REB</th>
              <th>AST</th>
              <th>STL</th>
              <th>TO</th>
            </tr>
          </thead>
          <tbody id="awayBox">{G.away.map(row)}</tbody>
        </table>
      </div>
    </div>
  );
}
