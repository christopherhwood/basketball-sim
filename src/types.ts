export type TeamSide = "home" | "away";
export type HoopSide = "L" | "R";
export type Pos = "PG" | "SG" | "SF" | "PF" | "C";
export type ShotType = "rim" | "close" | "mid" | "three";

export type Point = { x: number; y: number };

export type BaseAttributes = {
  speed: number;
  handleLeft: number;
  handleRight: number;
  pass: number;
  three: number;
  mid: number;
  finishing: number;
  perimD: number;
  steal: number;
  iq: number;
  strength: number;
  weight: number;
  vertical: number;
  rebound: number;
  interiorD: number;
  block: number;
  drawFoul: number;
  discipline: number;
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

export type ShotFreedom = "limited" | "normal" | "free";
export type ShotBias = "rim" | "balanced" | "three";
export type Playmaking = "score" | "balanced" | "facilitate";
export type ReboundRole = "getback" | "balanced" | "crash";
export type DefAggression = "safe" | "balanced" | "gamble";
export type HelpRole = "stayhome" | "balanced" | "help";

export type PlayerCoaching = {
  shotFreedom: ShotFreedom;
  shotBias: ShotBias;
  playmaking: Playmaking;
  reboundRole: ReboundRole;
  aggression: DefAggression;
  help: HelpRole;
};

export type Coaching = {
  perPlayer: Record<number, PlayerCoaching>;
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
  rimFga: number;
  reb: number;
  oreb: number;
  dreb: number;
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
  relocatedForDrive?: boolean;
  screenTarget?: Point | null;
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
  offLaneT?: number;
  defLaneT?: number;
  // help-defense recognition for the current drive: decided once, reset when the
  // drive ends. "in" = rotated to help, "out" = missed/declined the rotation.
  helpCommit?: "in" | "out" | null;
  // set on a teammate left open by a committed helper — primes a catch-and-shoot.
  catchShoot?: boolean;
  // diagnostics only: a short tag of what this player is currently trying to do
  // off the ball (pnr-roll, post, cut, laneclear, ...). Logged on a 3-second call
  // so we can see WHICH behavior left him camped in the lane. No gameplay effect.
  dbgIntent?: string;
};

export type ShotMeta = {
  shooter: Player;
  made: boolean;
  pts: number;
  type: ShotType;
  origin: Point;
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
  catchPoint?: Point | null;
  // in-flight pass heading (unit vector) + speed; the ball homes onto the live
  // receiver each tick with a capped turn rate so the path stays near-straight
  hx?: number;
  hy?: number;
  bspeed?: number;
};

export type Tactics = {
  defScheme: "man" | "zone23";
  pnr: "switch" | "drop" | "hedge";
  pressure: "sag" | "normal" | "tight";
  pace: "slow" | "bal" | "fast";
  shotSel: "rim" | "bal" | "three";
  action: "pnr" | "motion";
};

export type FeedEvent = { id: number; t: string; cls?: string };
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
  stealStart?: boolean;
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
  // per-possession PnR roll/pop decision for the screener (undefined until the
  // roll phase decides it): true = pick-and-pop to the arc, false = roll to the rim.
  screenPop?: boolean;
  // the big chosen to set the ball screen this possession (rotates C/PF, rarely
  // SF, weighted by screen tendency); cleared at each possession start.
  screenerPick?: Player | null;
  // a player who just secured an offensive rebound near the rim and should go
  // straight back up with a putback; cleared once he decides.
  putbackBy?: Player | null;
  driving?: boolean;
  // cumulative seconds the handler has patiently held/probed this possession
  // (no good look yet) — lets off-ball motion and a ball screen develop.
  holdT?: number;
  // on-ball drive-cutoff matchup resolved ONCE per drive: true = handler beat his
  // man (drive lives on), false = contained. undefined until the first roll.
  driveBeaten?: boolean;
  homeAttack?: HoopSide;
  awayAttack?: HoopSide;
  lastShooter?: Player;
  lastAssist?: Player | null;
  pendingAssist?: Player | null;
  // possClock at the moment the assist-eligible pass was caught — an assist only
  // counts if the basket follows the catch promptly (a direct result of the pass,
  // not a bucket the catcher created for himself after holding/dribbling).
  assistCatchT?: number;
  scoreFlash?: ScoreFlash;
  banner?: Banner;
  ft?: FreeThrowState | null;
  trans?: TransitionState | null;
}
