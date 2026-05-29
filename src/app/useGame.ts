import { useSyncExternalStore } from "react";
import { subscribe, getVersion } from "./store.js";

export function useGameVersion(): number {
  return useSyncExternalStore(subscribe, getVersion);
}
