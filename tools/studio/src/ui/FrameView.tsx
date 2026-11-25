import { useEffect, useRef } from "react";
import { FrameOverlay, type OverlayView } from "./frameOverlay.js";

interface Props {
  src: string;
  view: OverlayView | null;
  onSelect(idx: number): void;
  onHover(idx: number | null): void;
  onKey(ev: KeyboardEvent): void;
}

/**
 * The captured page in a sandboxed iframe: `sandbox="allow-same-origin"` WITHOUT allow-scripts, so the page cannot run
 * code while the app (same origin) can still draw on it. The server adds `Content-Security-Policy: default-src 'none'`.
 */
export function FrameView({ src, view, onSelect, onHover, onKey }: Props): React.ReactElement {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const overlay = useRef<FrameOverlay | null>(null);
  const latest = useRef({ view, onSelect, onHover, onKey });
  latest.current = { view, onSelect, onHover, onKey };

  const attach = (): void => {
    const doc = frame.current?.contentDocument;
    overlay.current?.destroy();
    overlay.current = null;
    if (!doc?.body) return;
    overlay.current = new FrameOverlay(doc, {
      onSelect: (i) => latest.current.onSelect(i),
      onHover: (i) => latest.current.onHover(i),
      onKey: (e) => latest.current.onKey(e),
    });
    const v = latest.current.view;
    if (v) overlay.current.render(v, { scroll: true });
    // Images and fonts that settle late move the elements: re-place the badges.
    for (const ms of [150, 600, 1500]) window.setTimeout(() => overlay.current?.layout(), ms);
  };

  useEffect(() => {
    if (view) overlay.current?.render(view, { scroll: true });
  }, [view]);

  useEffect(() => {
    const onResize = (): void => overlay.current?.layout();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      overlay.current?.destroy();
    };
  }, []);

  return <iframe ref={frame} className="page-frame" title="captured page" src={src} sandbox="allow-same-origin" onLoad={attach} data-testid="page-frame" />;
}
