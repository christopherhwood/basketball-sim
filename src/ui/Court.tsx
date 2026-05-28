import { useEffect, useRef } from "react";
import { G } from "../core/state.js";
import { createRenderer } from "../render/render.js";
import { setRenderer } from "../app/engine.js";
import { useGameVersion } from "../app/useGame.js";

export function Court(): React.JSX.Element {
  useGameVersion();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setRenderer(createRenderer(canvasRef.current!));
    return () => {
      setRenderer(null);
    };
  }, []);

  return (
    <>
      <canvas id="court" ref={canvasRef} width={760} height={404}></canvas>
      <div className="legend">
        <span>
          <i className="dot" style={{ background: "var(--home)" }}></i>your team
        </span>
        <span>
          <i className="dot" style={{ background: "var(--away)" }}></i>opponent
        </span>
        <span>
          <i className="dot" style={{ background: "var(--ball)" }}></i>ball
        </span>
        <span id="possLbl">possession: {G.offense === "home" ? "YOU" : "CPU"}</span>
      </div>
    </>
  );
}
