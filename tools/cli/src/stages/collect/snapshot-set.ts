/**
 * The `SnapshotSet` layout and its reader are shared with the label and dataset stages and live in
 * `@gran-prix/labels` (`set-readers.ts`: a package both sides already depend on, so no cycle). This file keeps
 * the import path of the collect stage stable.
 */
export {
  SNAPSHOT_SET_FORMAT,
  SnapshotSetReader,
  hexOf,
  htmlPath,
  snapshotPath,
  type FileSource,
  type SnapshotSetEntry,
  type SnapshotSetFailure,
  type SnapshotSetManifest,
} from "@gran-prix/labels";
