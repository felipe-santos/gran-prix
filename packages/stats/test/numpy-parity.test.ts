// Parity of the TS generator with numpy.random (PCG64, SeedSequence, Generator.integers) and numpy.quantile.
// The expected values are the fixture produced by the installed numpy (tools/baselines/stats/gen_numpy_vectors.py);
// the last test regenerates it with Python when numpy is importable and demands the same bytes.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Generator, PCG64, SeedSequence, quantileLinear } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../..");
const FIXTURE = join(HERE, "fixtures/numpy-parity.json");
const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as any;

const sha = (values: ArrayLike<number>): string => {
  const buf = Buffer.alloc(8 * values.length);
  for (let i = 0; i < values.length; i++) buf.writeBigInt64LE(BigInt(values[i] as number), 8 * i);
  return createHash("sha256").update(buf).digest("hex");
};
const big = (s: string): bigint => BigInt(s);

describe("PCG64 and SeedSequence against numpy", () => {
  for (const c of fx.raw) {
    it(`seed ${c.seed}: first 8 random_raw`, () => {
      const g = new PCG64(big(c.seed));
      expect(Array.from({ length: 8 }, () => g.nextUint64().toString())).toEqual(c.raw);
    });
  }

  it("the seed accepts a number and the equal bigint alike", () => {
    expect(new PCG64(20261125).nextUint64()).toBe(new PCG64(20261125n).nextUint64());
  });

  it("generate_state is the pool hashed to as many words as asked (a prefix property)", () => {
    const ss = new SeedSequence(20261125);
    expect(Array.from(ss.generateState(8).slice(0, 3))).toEqual(Array.from(ss.generateState(3)));
    expect(ss.pool).toHaveLength(4);
  });
});

describe("Generator.integers against numpy", () => {
  it("long sequences: first values, last values, digest of all 100000", () => {
    for (const c of fx.integers) {
      const g = Generator.defaultRng(big(c.seed));
      const high = Number(c.high);
      const v = g.integers(0, high, 100_000);
      const label = `seed ${c.seed}, high ${c.high}`;
      expect({ label, head: Array.from(v.slice(0, 16)) }).toEqual({ label, head: c.head });
      expect({ label, tail: Array.from(v.slice(-4)) }).toEqual({ label, tail: c.tail });
      expect({ label, sha: sha(v) }).toEqual({ label, sha: c.sha256 });
      expect(Math.max(...v)).toBe(c.max);
    }
  });

  it("successive calls on one generator, mixed ranges, offsets and the uint32 buffer", () => {
    for (const c of fx.scripts) {
      const g = Generator.defaultRng(big(c.seed));
      const out = c.calls.map(([low, high, size]: number[]) => Array.from(g.integers(low as number, high as number, size as number)));
      expect({ seed: c.seed, out }).toEqual({ seed: c.seed, out: c.out });
    }
  });

  it("2000 calls of 1..5 values (many of size 1), the digest of the lot", () => {
    const highs = [7, 100, 2 ** 32 + 5, 3, 2 ** 31, 1, 1000];
    for (const c of fx.long_scripts) {
      const g = Generator.defaultRng(big(c.seed));
      const flat: number[] = [];
      for (let i = 0; i < 2000; i++) flat.push(...g.integers(0, highs[i % 7] as number, 1 + ((i * 7) % 5)));
      expect(flat).toHaveLength(c.n);
      expect(flat.slice(0, 16)).toEqual(c.head);
      expect(sha(flat)).toBe(c.sha256);
    }
  });

  it("the scalar form draws exactly what the array form draws", () => {
    for (const c of fx.scalars) {
      const g = Generator.defaultRng(big(c.seed));
      const v = [...Array.from({ length: 20 }, () => g.integers(0, 6)), ...Array.from({ length: 4 }, () => g.integers(0, 2 ** 32 + 5))];
      expect(v).toEqual(c.values);
    }
  });

  it("fill() writes the same draws as integers(low, high, size)", () => {
    const a = Generator.defaultRng(20261125).integers(0, 37, 500);
    const out = new Float64Array(500);
    Generator.defaultRng(20261125).fill(out, 0, 37);
    expect(Array.from(out)).toEqual(Array.from(a));
  });
});

describe("numpy.quantile (method linear) against the TS interpolation", () => {
  it("matches numpy to the last bit on every fixture array and q", () => {
    for (const c of fx.quantiles) {
      c.q.forEach((q: number, i: number) => expect(quantileLinear(c.sorted, q)).toBe(c.out[i]));
    }
  });
});

describe("regeneration with the installed numpy", () => {
  const pylibs = join(REPO, "tools/baselines/.pylibs");
  const script = join(REPO, "tools/baselines/stats/gen_numpy_vectors.py");
  const env = { ...process.env, PYTHONPATH: [pylibs, process.env.PYTHONPATH].filter(Boolean).join(":") };
  const hasNumpy = existsSync(script) && spawnSync("python3", ["-c", "import numpy"], { env }).status === 0;

  // The fixture is a pure function of numpy (2.5.x); a different numpy that changes a stream must fail here.
  it.skipIf(!hasNumpy)("gen_numpy_vectors.py reproduces the committed fixture byte for byte", () => {
    const r = spawnSync("python3", [script], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFileSync(FIXTURE, "utf8"));
  });
});
