// Stand-in for `node:crypto` in the extension bundle: just `createHash("sha256").update(x).digest("hex")`,
// the only thing `@gran-prix/contracts` (identity/hash) uses. Any other algorithm or encoding throws.
import { sha256HexOfBytes } from "./sha256.js";

const enc = new TextEncoder();

export function createHash(algorithm) {
  if (algorithm !== "sha256") throw new Error(`crypto shim: only sha256 is available (asked for ${algorithm})`);
  const parts = [];
  const h = {
    update(data) {
      parts.push(typeof data === "string" ? enc.encode(data) : data);
      return h;
    },
    digest(encoding) {
      if (encoding !== "hex") throw new Error("crypto shim: only digest('hex') is available");
      let n = 0;
      for (const p of parts) n += p.length;
      const all = new Uint8Array(n);
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
      return sha256HexOfBytes(all);
    },
  };
  return h;
}
