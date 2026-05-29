import { G } from "../core/state.js";
import { useGameVersion } from "../app/useGame.js";

export function PlayByPlay(): React.JSX.Element {
  useGameVersion();
  return (
    <div className="feed" id="feed">
      {G.feed.map((e) => {
        const cls = e.cls === "sc" ? "sc-ev" : e.cls ? "to-ev" : "";
        return (
          <div key={e.id} className={`ev ${cls}`}>
            {e.t}
          </div>
        );
      })}
    </div>
  );
}
