import { G } from "../core/state.js";
import { useGameVersion } from "../app/useGame.js";

export function PlayByPlay(): React.JSX.Element {
  useGameVersion();
  return (
    <div className="feed" id="feed">
      {G.feed.map((e, i) => {
        const cls = e.cls === "sc" ? "sc-ev" : e.cls ? "to-ev" : "";
        return (
          <div key={i} className={`ev ${cls}`}>
            {e.t}
          </div>
        );
      })}
    </div>
  );
}
