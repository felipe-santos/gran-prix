import { useCallback, useEffect, useRef, useState } from "react";
import type { Mode } from "../core/types.js";
import { api } from "./api.js";

/** No input for this long and the clock stops: time spent away from the keyboard is not labeling time. */
export const IDLE_AFTER_MS = 60_000;

export interface ActiveTimer {
  /** Active seconds of this session so far. */
  seconds: number;
  /** Marks activity (key, click, mouse move). */
  touch(): void;
  /** Writes the session to the time log (append-only) and restarts it. No-op when nothing was worked. */
  flush(): void;
}

/**
 * Session timer of one page: counts one second per tick while the tab is visible and the user was active within
 * `IDLE_AFTER_MS`. `flush()` (page switch, tab hidden, window closing) appends {page, mode, start, end, seconds}
 * to timelog.jsonl through the server. `mode` is read at flush time.
 */
export function useActiveTimer(hex: string | null, getMode: () => Mode): ActiveTimer {
  const [seconds, setSeconds] = useState(0);
  const acc = useRef({ seconds: 0, start: new Date(), lastActive: Date.now() });
  const modeRef = useRef(getMode);
  modeRef.current = getMode;

  const flush = useCallback(() => {
    const a = acc.current;
    if (hex === null) return;
    const secs = Math.round(a.seconds);
    if (secs >= 1) void api.time(hex, { mode: modeRef.current(), start: a.start.toISOString(), end: new Date().toISOString(), seconds: secs }).catch(() => undefined);
    acc.current = { seconds: 0, start: new Date(), lastActive: Date.now() };
    setSeconds(0);
  }, [hex]);

  useEffect(() => {
    acc.current = { seconds: 0, start: new Date(), lastActive: Date.now() };
    setSeconds(0);
    const tick = window.setInterval(() => {
      const a = acc.current;
      if (document.visibilityState === "visible" && Date.now() - a.lastActive < IDLE_AFTER_MS) {
        a.seconds += 1;
        setSeconds(Math.floor(a.seconds));
      }
    }, 1000);
    const onHide = (): void => {
      if (document.visibilityState === "hidden") flush();
    };
    const onUnload = (): void => flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onUnload);
      flush();
    };
  }, [hex, flush]);

  const touch = useCallback(() => {
    acc.current.lastActive = Date.now();
  }, []);
  return { seconds, touch, flush };
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(r).padStart(2, "0")}s`;
}
