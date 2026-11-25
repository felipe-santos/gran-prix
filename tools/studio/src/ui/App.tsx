import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { PageList } from "./PageList.js";
import { PageView } from "./PageView.js";

export function App(): React.ReactElement {
  const [annotator, setAnnotator] = useState("");
  const [guide, setGuide] = useState(false);
  const [open, setOpen] = useState<string | null>(() => (location.hash.length > 1 ? location.hash.slice(1) : null));
  const [refreshKey, setRefreshKey] = useState(0);
  const others = useRef<(hex: string) => number>(() => 0);
  const [, force] = useState(0);

  useEffect(() => {
    void api.info().then((i) => {
      setAnnotator(i.annotator);
      setGuide(i.guide);
    });
  }, []);
  useEffect(() => {
    const onHash = (): void => setOpen(location.hash.length > 1 ? location.hash.slice(1) : null);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const onTotals = useCallback((f: (hex: string) => number) => {
    others.current = f;
    force((n) => n + 1);
  }, []);

  if (open) {
    return (
      <PageView
        hex={open}
        otherSeconds={others.current(open)}
        guideFile={guide}
        onBack={() => {
          history.pushState(null, "", location.pathname + location.search);
          setOpen(null);
          setRefreshKey((k) => k + 1);
        }}
      />
    );
  }
  return (
    <PageList
      annotator={annotator}
      refreshKey={refreshKey}
      onTotals={onTotals}
      onOpen={(hex) => {
        history.pushState(null, "", `${location.pathname}${location.search}#${hex}`);
        setOpen(hex);
      }}
    />
  );
}
