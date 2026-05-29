import {
  togglePlay,
  isRunning,
  step,
  simToEndOfQuarter,
  setSpeed,
  getSpeed,
  newMatchup,
} from "../app/engine.js";
import { getCurrentRosters } from "../app/matchup.js";
import { useGameVersion } from "../app/useGame.js";

const SPEEDS = [0.5, 1, 3, 8];

export function Controls(): React.JSX.Element {
  useGameVersion();
  const speed = getSpeed();

  return (
    <div className="controls">
      <button type="button" id="play" onClick={() => togglePlay()}>
        {isRunning() ? "❚❚ pause" : "▶ play"}
      </button>
      <button type="button" id="step" onClick={() => step()}>
        step
      </button>
      <button type="button" id="ff" onClick={() => simToEndOfQuarter()}>
        » sim to end of qtr
      </button>
      <button type="button" id="reset" className="warn" onClick={() => newMatchup(getCurrentRosters())}>
        reset game
      </button>
      <span className="speed">
        speed
        {SPEEDS.map((sp) => (
          <button
            type="button"
            key={sp}
            data-sp={sp}
            className={speed === sp ? "on" : undefined}
            onClick={() => setSpeed(sp)}
          >
            {sp}x
          </button>
        ))}
      </span>
    </div>
  );
}
