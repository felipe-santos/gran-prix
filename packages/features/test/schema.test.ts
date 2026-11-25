import { contractId, validate } from "@gran-prix/contracts";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURE_SPECS, buildFeatureSchemaV0, featureSchemaV0 } from "../src/index.js";

const jsonPath = fileURLToPath(new URL("../src/schema/feature-schema.v0.json", import.meta.url));

// `pnpm schema:regen` rewrites the committed file from the registry; the plain run only compares.
if (process.env["UPDATE_SCHEMA"]) {
  const doc = buildFeatureSchemaV0();
  doc.schema_id = contractId("feature-schema", doc as unknown as Record<string, unknown>);
  writeFileSync(jsonPath, JSON.stringify(doc, null, 2) + "\n");
}

describe("FeatureSchema v0", () => {
  const committed = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>;

  it("is valid under the contracts' feature-schema validator (shape, invariants, id)", () => {
    const r = validate("feature-schema", committed);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("has 40 to 60 features with stable, unique names and indices", () => {
    const feats = (committed["features"] as { index: number; name: string; doc: string }[]);
    expect(feats.length).toBeGreaterThanOrEqual(40);
    expect(feats.length).toBeLessThanOrEqual(60);
    expect(new Set(feats.map((f) => f.name)).size).toBe(feats.length);
    feats.forEach((f, i) => {
      expect(f.index).toBe(i);
      expect(f.doc.length).toBeGreaterThanOrEqual(8);
      expect(f.doc).not.toContain("\n");
    });
  });

  it("equals what the feature registry generates (no drift between code and the committed file)", () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildFeatureSchemaV0())));
    expect(featureSchemaV0.dim).toBe(FEATURE_SPECS.length);
  });

  it("gets its schema_id from the contracts' identity helper, and the in-bundle pure hash agrees", () => {
    const id = contractId("feature-schema", committed);
    expect(committed["schema_id"]).toBe(id);
    expect(buildFeatureSchemaV0().schema_id).toBe(id);
  });

  it("is documented: the README table lists every feature and the current schema_id", () => {
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    for (const f of featureSchemaV0.features) expect(readme, f.name).toContain(`| ${f.index} | \`${f.name}\` |`);
    expect(readme).toContain(featureSchemaV0.schema_id);
  });

  it("covers the required families", () => {
    const names = FEATURE_SPECS.map((f) => f.name);
    const has = (re: RegExp): boolean => names.some((n) => re.test(n));
    for (const re of [
      /^log_own_len$/, /^log_text_len$/, /^text_density$/, /^link_density$/, /^punct_ratio$/, /^stopword_ratio$/,
      /^tag_other$/, /^depth$/, /^sibling_/, /^parent_/, /^prev_/, /^next_/, /^visible$/, /^area_frac$/,
      /^y_center_rel$/, /^font_size_rel$/, /^font_weight_rel$/, /^idclass_hash_/, /^page_/, /^in_(main|nav|footer)$/,
    ]) expect(has(re), String(re)).toBe(true);
    for (const h of ["nav", "footer", "ad", "comment", "related", "cookie", "sidebar", "menu", "share"]) expect(names).toContain(`hint_${h}`);
  });
});
