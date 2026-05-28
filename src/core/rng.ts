let _state = 1 >>> 0;

export function seedRng(seed: number): void {
  _state = seed >>> 0;
}

export function rng(): number {
  _state = (_state + 0x6d2b79f5) >>> 0;
  let t = _state;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
