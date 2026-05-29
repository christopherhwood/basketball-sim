import { clamp, randn, chance } from "../core/math.js";
import { rng } from "../core/rng.js";
import { ARCH, type ArchetypeTemplate } from "./archetypes.js";
import { NAMES } from "./names.js";
import type { Attributes, Player, TeamSide } from "../types.js";

let namePool: string[] = [];

export function resetNamePool(): void {
  namePool = NAMES.slice().sort(() => rng() - 0.5);
}

export function genPlayer(archKey: string, team: TeamSide, num: number): Player {
  const a = ARCH[archKey];
  const attr = {} as Attributes;
  const p: Player = {
    team,
    num,
    pos: a.pos,
    arch: archKey,
    attr,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    hasBall: false,
    fatigue: 0,
    target: null,
    role: "spacer",
    assign: null,
    stats: { pts: 0, fga: 0, fgm: 0, tpa: 0, tpm: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, fta: 0, ftm: 0 },
    name: "",
  };
  for (const k in a.t) {
    const key = k as keyof ArchetypeTemplate;
    if (key === "tendShoot") {
      attr.tendShoot = clamp(a.t[key] + randn() * 0.05, 0.3, 0.9);
    } else if (key === "height") {
      attr.height = +(a.t[key] + randn() * 0.12).toFixed(2);
    } else {
      attr[key] = clamp(Math.round(a.t[key] + randn() * 6), 25, 99);
    }
  }
  p.tendencies = { ...ARCH[archKey].tend };
  p.name = namePool.pop() as string;
  return p;
}

export function genTeam(team: TeamSide): Player[] {
  const build = ["floor_gen", "sharp", "wing_3d", "stretch_4", "rim_big"];
  // swap one wing for a slasher sometimes for variety
  if (chance(0.5)) build[1] = "slasher";
  return build.map((k, i) => genPlayer(k, team, [1, 3, 7, 21, 33][i] + (team === "away" ? 40 : 0)));
}
