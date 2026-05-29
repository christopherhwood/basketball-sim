import { useState } from "react";
import type { Tactics } from "../types.js";
import { tactics } from "../tactics/tactics.js";

type SetKey = keyof Tactics;

type Option = { v: string; label: string };
type Seg = { set: SetKey; label: string; opts: Option[] };

const defenseSegs: Seg[] = [
  {
    set: "defScheme",
    label: "scheme",
    opts: [
      { v: "man", label: "man" },
      { v: "zone23", label: "2-3 zone" },
    ],
  },
  {
    set: "pnr",
    label: "pick & roll coverage",
    opts: [
      { v: "switch", label: "switch" },
      { v: "drop", label: "drop" },
      { v: "hedge", label: "hedge" },
    ],
  },
  {
    set: "pressure",
    label: "on-ball pressure",
    opts: [
      { v: "sag", label: "sag off" },
      { v: "normal", label: "normal" },
      { v: "tight", label: "tight" },
    ],
  },
];

const offenseSegs: Seg[] = [
  {
    set: "pace",
    label: "pace",
    opts: [
      { v: "slow", label: "slow" },
      { v: "bal", label: "balanced" },
      { v: "fast", label: "fast" },
    ],
  },
  {
    set: "shotSel",
    label: "shot selection",
    opts: [
      { v: "rim", label: "attack rim" },
      { v: "bal", label: "balanced" },
      { v: "three", label: "let it fly" },
    ],
  },
  {
    set: "action",
    label: "primary action",
    opts: [
      { v: "pnr", label: "pick & roll" },
      { v: "motion", label: "motion" },
    ],
  },
];

export function TacticsPanel(): React.JSX.Element {
  const [active, setActive] = useState<Tactics>({ ...tactics });

  const choose = (set: SetKey, v: string): void => {
    (tactics[set] as string) = v;
    setActive((prev) => ({ ...prev, [set]: v }));
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
    <>
      <div className="card">
        <h2>Your defense</h2>
        {defenseSegs.map(renderSeg)}
      </div>
      <div className="card">
        <h2>Your offense</h2>
        {offenseSegs.map(renderSeg)}
      </div>
    </>
  );
}
