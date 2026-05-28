type Listener = () => void;

let version = 0;
const listeners = new Set<Listener>();

export function subscribe(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getVersion(): number {
  return version;
}

export function notify(): void {
  version++;
  for (const cb of listeners) cb();
}
