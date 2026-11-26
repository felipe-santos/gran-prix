import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { CalibrationSide } from "./CalibrationView.js";
import { PageList } from "./PageList.js";
import { PageView } from "./PageView.js";
import { TaskHome } from "./TaskHome.js";
import { TaskView } from "./TaskView.js";

/**
 * Routes, in the URL hash:
 *   (empty)            the tasks (home); the free list of pages when the data dir has no queue and no calibration to do
 *   #/all              the free list of pages (mode chosen per page)
 *   #<64 hex>          a page in free mode
 *   #/t/<task>         one task
 *   #/t/<task>/<hex>   a page inside a task (the mode is the task's, fixed by the server)
 */
type Route = { kind: "home" } | { kind: "all" } | { kind: "free"; hex: string } | { kind: "task"; task: string } | { kind: "task-page"; task: string; hex: string };

export function parseHash(h: string): Route {
  const s = h.startsWith("#") ? h.slice(1) : h;
  if (s === "" || s === "/") return { kind: "home" };
  if (s === "/all") return { kind: "all" };
  const m = /^\/t\/([a-z0-9-]+)(?:\/([0-9a-f]{64}))?$/.exec(s);
  if (m) return m[2] ? { kind: "task-page", task: m[1] as string, hex: m[2] } : { kind: "task", task: m[1] as string };
  if (/^[0-9a-f]{64}$/.test(s)) return { kind: "free", hex: s };
  return { kind: "home" };
}

const go = (hash: string): void => {
  history.pushState(null, "", `${location.pathname}${location.search}${hash === "" ? "" : `#${hash}`}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
};

export function App(): React.ReactElement {
  const [annotator, setAnnotator] = useState("");
  const [guide, setGuide] = useState(false);
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [hasTasks, setHasTasks] = useState<boolean | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const others = useRef<(hex: string) => number>(() => 0);
  const [, force] = useState(0);

  useEffect(() => {
    void api.info().then((i) => {
      setAnnotator(i.annotator);
      setGuide(i.guide);
    });
    // The home shows the tasks when there is something to do in them: a queue, or a calibration whose fixtures are all collected.
    void api
      .tasks()
      .then((r) => setHasTasks(r.tasks.some((t) => t.kind === "queue" || t.available === true) || r.invalid.length > 0))
      .catch(() => setHasTasks(false));
  }, []);
  useEffect(() => {
    const onHash = (): void => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, []);
  const onTotals = useCallback((f: (hex: string) => number) => {
    others.current = f;
    force((n) => n + 1);
  }, []);

  if (route.kind === "free") {
    return (
      <PageView
        hex={route.hex}
        task={null}
        otherSeconds={others.current(route.hex)}
        guideFile={guide}
        onBack={() => {
          go("/all");
          setRefreshKey((k) => k + 1);
        }}
      />
    );
  }
  if (route.kind === "task-page") {
    const { task } = route;
    return (
      <PageView
        hex={route.hex}
        task={task}
        otherSeconds={0}
        guideFile={guide}
        onBack={() => go(`/t/${task}`)}
        {...(task === "calibration" ? { renderExtra: (ctx) => <CalibrationSide ctx={ctx} /> } : {})}
      />
    );
  }
  if (route.kind === "task") {
    const { task } = route;
    return <TaskView key={task} task={task} onOpenPage={(hex) => go(`/t/${task}/${hex}`)} onHome={() => go("")} />;
  }
  if (route.kind === "home" && hasTasks === null) return <div className="center">Carregando…</div>;
  if (route.kind === "home" && hasTasks) return <TaskHome onOpen={go} onAll={() => go("/all")} />;
  return (
    <PageList
      annotator={annotator}
      refreshKey={refreshKey}
      onTotals={onTotals}
      onOpen={(hex) => go(hex)}
      {...(hasTasks ? { onTasks: () => go("") } : {})}
    />
  );
}
