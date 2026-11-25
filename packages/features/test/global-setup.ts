// Builds the in-page IIFE once per test run, so a clean clone needs no prior `pnpm build`.
// @ts-expect-error plain .mjs without declarations
import { writeBundle } from "../scripts/bundle.mjs";

export default async function setup(): Promise<void> {
  await writeBundle();
}
