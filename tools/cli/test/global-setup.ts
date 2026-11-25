// Builds the in-page IIFE of @gran-prix/features once per test run, so a clean clone needs no prior build.
// @ts-expect-error plain .mjs without declarations
import { writeBundle } from "../../../packages/features/scripts/bundle.mjs";

export default async function setup(): Promise<void> {
  await writeBundle();
}
