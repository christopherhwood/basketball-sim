import type { Player } from "../types.js";
import { tendenciesOf } from "../sim/tendency.js";

/* Read-only scouting view of a player's attributes and tendencies. Shows the
   player's innate ratings only — the effect of coaching is intentionally not
   surfaced here. */

const ATTR_ROWS: { key: keyof Player["attr"]; label: string }[] = [
  { key: "speed", label: "Speed" },
  { key: "handle", label: "Handle" },
  { key: "pass", label: "Pass" },
  { key: "three", label: "3PT" },
  { key: "mid", label: "Mid" },
  { key: "finishing", label: "Finishing" },
  { key: "perimD", label: "Perim D" },
  { key: "steal", label: "Steal" },
  { key: "iq", label: "IQ" },
  { key: "strength", label: "Strength" },
  { key: "vertical", label: "Vertical" },
  { key: "rebound", label: "Rebound" },
  { key: "interiorD", label: "Interior D" },
  { key: "block", label: "Block" },
];

const TEND_ROWS: { key: keyof ReturnType<typeof tendenciesOf>; label: string }[] = [
  { key: "shootThree", label: "Shoot 3" },
  { key: "shootMid", label: "Shoot Mid" },
  { key: "driveRim", label: "Drive" },
  { key: "pass", label: "Pass" },
  { key: "postUp", label: "Post Up" },
  { key: "screen", label: "Screen" },
  { key: "helpDefense", label: "Help D" },
  { key: "gambleSteal", label: "Gamble" },
  { key: "crashGlass", label: "Crash" },
  { key: "pushTransition", label: "Push" },
];

function feetInches(h: number): string {
  const f = Math.floor(h);
  const inches = Math.round((h - f) * 12);
  return inches === 12 ? `${f + 1}'0"` : `${f}'${inches}"`;
}

function StatRow({ label, value, max }: { label: string; value: number; max: number }): React.JSX.Element {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className="stat-bar">
        <span style={{ width: `${(value / max) * 100}%` }} />
      </span>
      <span className="stat-val">{value}</span>
    </div>
  );
}

export function PlayerInspector({ player, onClose }: { player: Player; onClose: () => void }): React.JSX.Element {
  const tend = tendenciesOf(player);
  return (
    <dialog className="popover" open aria-label={`${player.name} attributes`}>
      <button type="button" className="popover-close" onClick={onClose} aria-label="close">
        ×
      </button>
      <h3>
        #{player.num} {player.name}
      </h3>
      <div className="popover-sub">
        {player.pos} · {feetInches(player.attr.height)}
      </div>

      <div className="stat-sec">Attributes</div>
      <div className="stat-grid">
        {ATTR_ROWS.map((r) => (
          <StatRow key={r.key} label={r.label} value={player.attr[r.key]} max={99} />
        ))}
      </div>

      <div className="stat-sec">Tendencies</div>
      <div className="stat-grid">
        {TEND_ROWS.map((r) => (
          <StatRow key={r.key} label={r.label} value={tend[r.key]} max={100} />
        ))}
      </div>
    </dialog>
  );
}
