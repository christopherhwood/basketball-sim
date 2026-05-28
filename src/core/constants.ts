import type { HoopSide, Point } from "../types.js";

export const COURT_L = 94;
export const COURT_W = 50;
export const HOOP: Record<HoopSide, Point> = { L: { x: 5.25, y: 25 }, R: { x: 88.75, y: 25 } };
export const ARC_R = 23.75;
export const DT = 0.1;
