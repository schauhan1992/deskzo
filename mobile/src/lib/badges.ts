import { useSyncExternalStore } from "react";

/** How many decisions wait for the person — set by Today and Approvals, shown on the Approvals tab. */

let waiting = 0;
const listeners = new Set<() => void>();

export function setWaiting(count: number) {
  if (count === waiting) return;
  waiting = count;
  listeners.forEach((l) => l());
}

export function useWaiting(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => waiting,
  );
}
