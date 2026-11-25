import { createHash } from "node:crypto";

import type { SplitName } from "../dataset.js";
export type SplitRanges = Readonly<Record<SplitName, readonly [number, number]>>;

export const DEFAULT_SPLIT_RANGES: SplitRanges = { train: [0, 70], val: [70, 85], test: [85, 100] };

/**
 * Split bucket of a group (scheme `hash-bucket-v1`):
 * `u32_be(sha256(salt + "\0" + group_key)[0..4]) % n_buckets`.
 *
 * No PRNG: the bucket of a group never changes when other groups are added.
 * For the DOM pipeline `group_key` is the registrable domain (ADR-006), so all
 * pages of a site land in the same split.
 */
export function groupBucket(salt: string, groupKey: string, nBuckets = 100): number {
  const digest = createHash("sha256").update(`${salt}\0${groupKey}`).digest();
  return digest.readUInt32BE(0) % nBuckets;
}

/** Split of a bucket given half-open `[lo, hi)` ranges. Throws if no range contains it. */
export function splitOfBucket(bucket: number, ranges: SplitRanges = DEFAULT_SPLIT_RANGES): SplitName {
  for (const name of ["train", "val", "test"] as const) {
    const [lo, hi] = ranges[name];
    if (bucket >= lo && bucket < hi) return name;
  }
  throw new RangeError(`bucket ${bucket} is not covered by the split ranges`);
}

/** Split of a group: manual `overrides` win, then the hash bucket. */
export function assignSplit(
  salt: string,
  groupKey: string,
  opts: { ranges?: SplitRanges; nBuckets?: number; overrides?: Readonly<Record<string, SplitName>> } = {},
): { split: SplitName; bucket: number } {
  const bucket = groupBucket(salt, groupKey, opts.nBuckets ?? 100);
  const override = opts.overrides?.[groupKey];
  return { split: override ?? splitOfBucket(bucket, opts.ranges), bucket };
}
