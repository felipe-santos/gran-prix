// Values the global setup (test/global-setup.ts) hands to the tests through `provide`.
import "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    corpusDir: string;
  }
}
