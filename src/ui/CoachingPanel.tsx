import { useState } from "react";
import type { PlayerCoaching } from "../types.js";
import { G } from "../core/state.js";
import { useGameVersion } from "../app/useGame.js";
import { playerCoaching, setPlayerCoaching } from "../coaching/coaching.js";

type CoachKey = keyof PlayerCoaching;

type Option = { v: string; label: string };
type Seg = { set: CoachKey; label: string; opts: Option[] };

const offenseSegs: Seg[] = [
  {
    set: "shotFreedom",
    label: "shot freedom",
    opts: [
      { v: "limited", label: "limited" },
      { v: "normal", label: "normal" },
      { v: "free", label: "free" },
    ],
  },
  {
    set: "shotBias",
    label: "shot bias",
    opts: [
      { v: "rim", label: "rim" },
      { v: "balanced", label: "balanced" },
      { v: "three", label: "three" },
    ],
  },
  {
    set: "playmaking",
    label: "playmaking",
    opts: [
      { v: "score", label: "score" },
      { v: "balanced", label: "balanced" },
      { v: "facilitate", label: "facilitate" },
    ],
  },
];

const defenseSegs: Seg[] = [
  {
    set: "reboundRole",
    label: "rebounding",
    opts: [
      { v: "getback", label: "get back" },
      { v: "balanced", label: "balanced" },
      { v: "crash", label: "crash" },
    ],
  },
  {
    set: "aggression",
    label: "steals",
    opts: [
      { v: "safe", label: "safe" },
      { v: "balanced", label: "balanced" },
      { v: "gamble", label: "gamble" },
    ],
  },
  {
    set: "help",
    label: "help",
    opts: [
      { v: "stayhome", label: "stay home" },
      { v: "balanced", label: "balanced" },
      { v: "help", label: "help" },
    ],
  },
];

export function CoachingPanel(): React.JSX.Element {
  useGameVersion();

  const roster = G.home;
  const [selected, setSelected] = useState<number>(roster[0]?.num ?? 0);
  const [active, setActive] = useState<PlayerCoaching>({ ...playerCoaching(selected) });

  const selectPlayer = (num: number): void => {
    setSelected(num);
    setActive({ ...playerCoaching(num) });
  };

  const choose = (set: CoachKey, v: string): void => {
    const updated: PlayerCoaching = { ...playerCoaching(selected), [set]: v };
    setPlayerCoaching(selected, updated);
    setActive(updated);
  };

  const renderSeg = (seg: Seg): React.JSX.Element => (
    <div className="seg" key={seg.set}>
      <label>{seg.label}</label>
      <div className="opts" data-set={seg.set}>
        {seg.opts.map((o) => (
          <button
            type="button"
            key={o.v}
            className={active[seg.set] === o.v ? "opt on" : "opt"}
            data-v={o.v}
            onClick={() => choose(seg.set, o.v)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="card">
      <h2>Coaching</h2>
      <div className="opts">
        {roster.map((p) => (
          <button
            type="button"
            key={p.num}
            className={selected === p.num ? "opt on" : "opt"}
            onClick={() => selectPlayer(p.num)}
          >
            {p.num} {p.name}
          </button>
        ))}
      </div>
      {offenseSegs.map(renderSeg)}
      {defenseSegs.map(renderSeg)}
    </div>
  );
}
