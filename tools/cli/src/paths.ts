import { join } from "node:path";

/** Layout of a data directory. */
export function dataPaths(dataDir: string): {
  artifacts: string;
  cache: string;
  runs: string;
  ledger: string;
} {
  return {
    artifacts: join(dataDir, "artifacts"),
    cache: join(dataDir, "cache"),
    runs: join(dataDir, "runs"),
    ledger: join(dataDir, "ledger.jsonl"),
  };
}

/** `sha256:ab12...` -> `sha256:ab12cd34…` for display. */
export function shortId(id: string, hexChars = 12): string {
  const i = id.indexOf(":");
  return i < 0 ? id : `${id.slice(0, i + 1)}${id.slice(i + 1, i + 1 + hexChars)}`;
}
