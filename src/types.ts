export type TeamSide = "home" | "away";
export type HoopSide = "L" | "R";
export type Pos = "PG" | "SG" | "SF" | "PF" | "C";
export type ShotType = "rim" | "close" | "mid" | "three";

export type Point = { x: number; y: number };

export type BaseAttributes = {
  speed: number;
  handle: number;
  pass: number;
  three: number;
  mid: number;
  finishing: number;
  perimD: number;
  steal: number;
  iq: number;
  strength: number;
  vertical: number;
  rebound: number;
  interiorD: number;
  block: number;
};

export type Attributes = BaseAttributes & {
  height: number;
  tendShoot: number;
};

export type Tendencies = {
  shootThree: number;
  shootMid: number;
  driveRim: number;
  pass: number;
  postUp: number;
  screen: number;
  helpDefense: number;
  gambleSteal: number;
  crashGlass: number;
  pushTransition: number;
};

export type PlayerData = {
  name: string;
  number: number;
  position: Pos;
  height: number;
  attributes: BaseAttributes;
  tendencies: Tendencies;
};

export type TeamData = {
  id: string;
  name: string;
  abbrev: string;
  players: PlayerData[];
};

export type FreeAgentData = {
  players: PlayerData[];
};

export type Stats = {
  pts: number;
  fga: number;
  fgm: number;
  tpa: number;
  tpm: number;
  reb: number;
  ast: number;
  stl: number;
  blk: number;
  tov: number;
  fta: number;
  ftm: number;
};

export type OffBallState = {
  state: string;
  t: number;
  spot: number;
  cutY?: number;
  fill?: Point | null;
};

export type Player = {
  team: TeamSide;
  num: number;
  pos: Pos;
  arch: string;
  attr: Attributes;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hasBall: boolean;
  fatigue: number;
  target: Point | null;
  role: string;
  assign: Player | null;
  stats: Stats;
  name: string;
  ob?: OffBallState;
  tendencies?: Tendencies;
};

export type ShotMeta = {
  shooter: Player;
  made: boolean;
  pts: number;
  type: ShotType;
};

export type Ball = {
  x: number;
  y: number;
  state: string;
  holder: Player | null;
  target: Player | null;
  flight: number;
  shotMeta: ShotMeta | null;
  from?: Player | null;
  passDur?: number;
};

export type Tactics = {
  defScheme: "man" | "zone23";
  pnr: "switch" | "drop" | "hedge";
  pressure: "sag" | "normal" | "tight";
  pace: "slow" | "bal" | "fast";
  shotSel: "rim" | "bal" | "three";
  action: "pnr" | "motion";
};

export type FeedEvent = { t: string; cls?: string };
export type Screen = { ball: Player; screener: Player };
export type ScoreFlash = { x: number; y: number; pts: number; team: TeamSide; t: number };
export type Banner = { text: string; t: number };

export interface FreeThrowState {
  shooter: Player;
  total: number;
  idx: number;
  phase: string;
  t: number;
  pct: number;
  thisMade: boolean;
  from?: Point;
}

export interface TransitionState {
  phase: string;
  t: number;
  pg: Player;
  scored?: HoopSide;
  inbounder?: Player;
  from?: Point;
  fastbreak?: boolean;
  kind?: string;
  outletFrom?: Player;
}

export interface GameState {
  home: Player[];
  away: Player[];
  offense: TeamSide;
  attackHoop: HoopSide;
  ball: Ball;
  score: { home: number; away: number };
  quarter: number;
  qLen: number;
  gameClock: number;
  shotClock: number;
  possClock: number;
  decideCD: number;
  actionPhase: string;
  actionT: number;
  screen: Screen | null;
  over: boolean;
  feed: FeedEvent[];
  pnrSwitched?: boolean;
  driving?: boolean;
  homeAttack?: HoopSide;
  awayAttack?: HoopSide;
  lastShooter?: Player;
  lastAssist?: Player | null;
  pendingAssist?: Player | null;
  scoreFlash?: ScoreFlash;
  banner?: Banner;
  ft?: FreeThrowState | null;
  trans?: TransitionState | null;
}
