// Values the global setup (test/global-setup.ts) hands to the tests through `provide`.
import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    /** A gp data dir whose artifact store holds a SnapshotSet of two fixture pages (read-only: copy before writing). */
    corpusDataDir: string;
  }
}
