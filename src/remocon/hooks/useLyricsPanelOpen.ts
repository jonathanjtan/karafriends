import { useSyncExternalStore } from "react";

// Whether this phone shows the now-playing lyrics panel. A per-device
// preference rather than a synced setting: it's about what's on this screen,
// and one person wanting lyrics says nothing about anyone else's phone.
//
// A tiny store rather than component state because the button (in the
// control bar's now-playing row) and the panel it opens are siblings.

const STORAGE_KEY = "showLyrics";

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let open = readStored();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setLyricsPanelOpen(next: boolean) {
  open = next;
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Private mode and friends: the toggle still works for this visit.
  }
  listeners.forEach((listener) => listener());
}

export default function useLyricsPanelOpen(): [
  boolean,
  (open: boolean) => void,
] {
  return [useSyncExternalStore(subscribe, () => open), setLyricsPanelOpen];
}
