/**
 * Structural backward-compatibility check between two JSON Schemas (draft-07 subset emitted by TypeBox):
 * everything the OLD schema accepts must still be accepted by the NEW one. It is conservative (it may report a
 * problem for an exotic but equivalent rewrite); it never misses what it models:
 *   - a property of the old schema is missing, or incompatible, in the new one;
 *   - the new schema requires something the old one did not;
 *   - a type, const or enum of the old schema is narrowed;
 *   - numeric / string / array bounds are tightened, a pattern changes;
 *   - an old union branch has no compatible branch in the new union.
 * Widening (new optional properties, extra enum values or union branches, relaxed bounds) is allowed.
 */
type S = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function resolve(root: S, node: S): S {
  let cur = node;
  for (let i = 0; i < 20 && typeof cur["$ref"] === "string"; i++) {
    const path = (cur["$ref"] as string).replace(/^#\//, "").split("/");
    let target: any = root; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const seg of path) target = target?.[seg];
    if (!target) throw new Error(`unresolvable $ref ${cur["$ref"]}`);
    cur = target as S;
  }
  return cur;
}

/** allOf -> one object schema (properties and required are unioned). */
function flatten(root: S, node: S): S {
  const n = resolve(root, node);
  if (!Array.isArray(n["allOf"])) return n;
  const merged: S = { ...n };
  delete merged["allOf"];
  for (const part of n["allOf"] as S[]) {
    const p = flatten(root, part);
    merged["properties"] = { ...(merged["properties"] ?? {}), ...(p["properties"] ?? {}) };
    merged["required"] = [...new Set([...(merged["required"] ?? []), ...(p["required"] ?? [])])];
    for (const k of Object.keys(p)) if (!(k in merged) && k !== "properties" && k !== "required") merged[k] = p[k];
  }
  return merged;
}

export function compatIssues(oldRoot: S, newRoot: S): string[] {
  const seen = new Set<string>();

  function walk(oNode: S, nNode: S, path: string): string[] {
    // Two named definitions are compared once (also what makes recursive schemas terminate).
    if (typeof oNode["$ref"] === "string" && typeof nNode["$ref"] === "string") {
      const key = `${oNode["$ref"]}|${nNode["$ref"]}`;
      if (seen.has(key)) return [];
      seen.add(key);
    }
    const o = flatten(oldRoot, oNode);
    const n = flatten(newRoot, nNode);
    const out: string[] = [];
    const bad = (m: string): void => void out.push(`${path}: ${m}`);

    if (Array.isArray(o["anyOf"])) {
      for (const [i, branch] of (o["anyOf"] as S[]).entries()) {
        const targets = Array.isArray(n["anyOf"]) ? (n["anyOf"] as S[]) : [n];
        if (!targets.some((t) => walk(branch, t, `${path}|${i}`).length === 0)) bad(`old union branch ${i} has no compatible branch in the new schema`);
      }
      return out;
    }
    if (Array.isArray(n["anyOf"])) {
      if (!(n["anyOf"] as S[]).some((t) => walk(o, t, path).length === 0)) bad("the new union has no branch compatible with the old schema");
      return out;
    }

    if ("const" in o && JSON.stringify(n["const"]) !== JSON.stringify(o["const"])) bad(`const changed from ${JSON.stringify(o["const"])}`);
    if (o["enum"]) {
      const ne: unknown[] = n["enum"] ?? (n["const"] !== undefined ? [n["const"]] : []);
      for (const v of o["enum"] as unknown[]) if (!ne.some((x) => JSON.stringify(x) === JSON.stringify(v))) bad(`enum value ${JSON.stringify(v)} removed`);
    }
    if (o["type"] !== undefined && JSON.stringify(n["type"]) !== JSON.stringify(o["type"])) bad(`type changed from ${JSON.stringify(o["type"])} to ${JSON.stringify(n["type"])}`);
    if (o["pattern"] !== n["pattern"]) bad(`pattern changed (${o["pattern"]} -> ${n["pattern"]})`);
    for (const k of ["minimum", "minLength", "minItems", "exclusiveMinimum", "minProperties"]) {
      if (n[k] !== undefined && (o[k] === undefined || n[k] > o[k])) bad(`${k} tightened (${o[k]} -> ${n[k]})`);
    }
    for (const k of ["maximum", "maxLength", "maxItems", "exclusiveMaximum", "maxProperties"]) {
      if (n[k] !== undefined && (o[k] === undefined || n[k] < o[k])) bad(`${k} tightened (${o[k]} -> ${n[k]})`);
    }

    if (o["properties"]) {
      for (const [k, v] of Object.entries(o["properties"] as S)) {
        const nv = n["properties"]?.[k];
        if (nv === undefined) bad(`property "${k}" removed`);
        else out.push(...walk(v as S, nv as S, `${path}.${k}`));
      }
    }
    for (const r of (n["required"] ?? []) as string[]) if (!((o["required"] ?? []) as string[]).includes(r)) bad(`"${r}" became required`);
    if (o["additionalProperties"] === false && n["additionalProperties"] !== false) {
      /* widening a closed object is allowed for old documents */
    }
    if (n["additionalProperties"] === false && o["additionalProperties"] !== false) bad("object closed to additional properties");
    if (typeof o["additionalProperties"] === "object" && o["additionalProperties"] !== null) {
      const na = n["additionalProperties"];
      if (typeof na === "object" && na !== null) out.push(...walk(o["additionalProperties"] as S, na as S, `${path}.*`));
      else if (na === false) bad("additionalProperties removed");
    }
    if (Array.isArray(o["items"])) {
      (o["items"] as S[]).forEach((it, i) => {
        const ni = Array.isArray(n["items"]) ? (n["items"] as S[])[i] : undefined;
        if (!ni) bad(`tuple item ${i} removed`);
        else out.push(...walk(it, ni, `${path}[${i}]`));
      });
    } else if (o["items"] && typeof o["items"] === "object") {
      if (n["items"] && !Array.isArray(n["items"])) out.push(...walk(o["items"] as S, n["items"] as S, `${path}[]`));
      else bad("items changed");
    }
    return out;
  }

  const oRoot = flatten(oldRoot, oldRoot);
  return walk(oRoot, newRoot, "$");
}
