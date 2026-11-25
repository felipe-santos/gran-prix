import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { TOKENIZER_NAME } from "./tokens.js";

/**
 * Bump when the converter's output can change for the same inputs (plan rules, pruning rules, the img rule, the
 * D1 scanner, the empty-output policy). It is part of the cache key of the stage through `converterDigests()`.
 */
export const CONVERTER_VERSION = "1.0.0";

const require = createRequire(import.meta.url);

/** Package directory of an installed dependency, found from its entry point (works with `exports` maps that hide package.json). */
function packageDir(name: string, entry: string): string {
  let dir = dirname(require.resolve(entry));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === name) return dir;
    } catch {
      // no package.json at this level
    }
    const up = dirname(dir);
    if (up === dir) throw new Error(`cannot locate the package directory of ${name}`);
    dir = up;
  }
}

function installedVersion(name: string, entry: string): string {
  return (JSON.parse(readFileSync(join(packageDir(name, entry), "package.json"), "utf8")) as { version: string }).version;
}

export interface ConverterVersions {
  converter: string;
  turndown: string;
  turndown_plugin_gfm: string;
  js_tiktoken: string;
  jsdom: string;
  tokenizer: string;
}

/** The exact versions D2, the pruned output and the counts depend on. */
export function converterVersions(): ConverterVersions {
  return {
    converter: CONVERTER_VERSION,
    turndown: installedVersion("turndown", "turndown"),
    turndown_plugin_gfm: installedVersion("turndown-plugin-gfm", "turndown-plugin-gfm"),
    js_tiktoken: installedVersion("js-tiktoken", "js-tiktoken/lite"),
    jsdom: installedVersion("jsdom", "jsdom"),
    tokenizer: TOKENIZER_NAME,
  };
}

/** `markdown@1.0.0+turndown@7.2.5+gfm@1.0.2`: what `TokenReduction.converter` records. */
export function converterLabel(v: ConverterVersions = converterVersions()): string {
  return `gp-markdown@${v.converter}+turndown@${v.turndown}+gfm@${v.turndown_plugin_gfm}+jsdom@${v.jsdom}`;
}

/** `cl100k_base@js-tiktoken@1.0.21`: what `TokenReduction.tokenizer` records. */
export function tokenizerLabel(v: ConverterVersions = converterVersions()): string {
  return `${v.tokenizer}@js-tiktoken@${v.js_tiktoken}`;
}

const sha256 = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

/**
 * Digest per dependency for the stage cache key: the version AND the bytes of the entry file (a patched or re-built
 * install changes the key). `gp-markdown` is the converter version constant.
 */
export function converterDigests(): Record<string, `sha256:${string}`> {
  const v = converterVersions();
  const file = (entry: string): Uint8Array => readFileSync(require.resolve(entry));
  const d = (label: string, bytes?: Uint8Array): `sha256:${string}` => `sha256:${sha256(bytes ? `${label}\n${sha256(bytes)}` : label)}`;
  return {
    "gp-markdown": d(`gp-markdown@${v.converter}`),
    turndown: d(`turndown@${v.turndown}`, file("turndown")),
    "turndown-plugin-gfm": d(`turndown-plugin-gfm@${v.turndown_plugin_gfm}`, file("turndown-plugin-gfm")),
    "js-tiktoken": d(`js-tiktoken@${v.js_tiktoken}`, file("js-tiktoken/ranks/cl100k_base")),
    jsdom: d(`jsdom@${v.jsdom}`),
  };
}
