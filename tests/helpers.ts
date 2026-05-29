/*
 * Shared test helpers.
 *
 * `breathe` yields to the event loop. The statistical specs run many full
 * seeded games in tight synchronous loops; awaiting it once per game keeps the
 * longest uninterrupted block short so Vitest's worker can still answer the
 * main process's RPC heartbeat (onTaskUpdate) instead of tripping its timeout
 * on CI's slower runners.
 */
export const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
