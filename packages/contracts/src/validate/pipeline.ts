import { Ajv, type ErrorObject } from "ajv";
import type { PipelineSpec } from "../pipeline-spec.js";
import type { StageKindSpec } from "../stage-kind-spec.js";
import { refsOf } from "./inv-graph.js";
import { Issues, pointerToPath, type ContractIssue } from "./result.js";

const VAR_RE = /\$\{vars\.([A-Za-z_][A-Za-z0-9_]*)\}/g;
const WHOLE_VAR_RE = /^\$\{vars\.([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Substitutes `${vars.name}` in params. A string that is exactly one
 * placeholder takes the variable's TYPE (number stays number); a placeholder
 * inside a longer string is interpolated as text. Unknown variables are
 * reported through `onMissing` and left untouched.
 */
export function resolveVars(
  value: unknown,
  vars: Readonly<Record<string, string | number | boolean>> = {},
  onMissing: (name: string) => void = () => undefined,
): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_VAR_RE.exec(value);
    if (whole) {
      const name = whole[1] as string;
      if (name in vars) return vars[name];
      onMissing(name);
      return value;
    }
    return value.replace(VAR_RE, (m, name: string) => {
      if (name in vars) return String(vars[name]);
      onMissing(name);
      return m;
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveVars(v, vars, onMissing));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveVars(v, vars, onMissing)]));
  }
  return value;
}

function ajvIssues(errors: ErrorObject[] | null | undefined, base: string): ContractIssue[] {
  return (errors ?? []).map((e) => {
    const sub = pointerToPath(e.instancePath);
    const missing = e.keyword === "required" ? `.${String((e.params as { missingProperty?: string }).missingProperty)}` : "";
    return {
      code: "schema" as const,
      contract: "pipeline-spec",
      path: `${base}${sub === "$" ? "" : `.${sub}`}${missing}`,
      message: e.message ?? e.keyword,
    };
  });
}

/**
 * Full pipeline validation (A1 section 2.10): the structural checks of
 * `validate("pipeline-spec", ...)` PLUS, given the stage registry:
 *  - every stage's `impl` is registered and its `kind` matches;
 *  - `params` (after `${vars}` substitution) conform to the kind's `params_schema`;
 *  - required ports are connected, no unknown ports, `many` ports get arrays;
 *  - the artifact type of every edge matches (producer output port -> consumer input port);
 *  - stages whose determinism is `seeded` have a `seed` param.
 * Cross-stage VALUE checks (NetworkDef.input_dim === FeatureSchema.dim, ...) need
 * the artifacts themselves and belong to the runner.
 */
export function pipelineRegistryIssues(spec: PipelineSpec, kinds: readonly StageKindSpec[]): ContractIssue[] {
  const out = new Issues("pipeline-spec");
  const byImpl = new Map(kinds.map((k) => [k.impl, k]));
  const stageKind = new Map(spec.stages.map((s) => [s.id, byImpl.get(s.impl)]));
  const issues: ContractIssue[] = [];
  const ajv = new Ajv({ strict: false, allErrors: true });

  spec.stages.forEach((st, i) => {
    const at = `stages[${i}]`;
    const k = byImpl.get(st.impl);
    if (!k) {
      out.invariant(`${at}.impl`, `unknown implementation "${st.impl}" (not in the stage registry)`);
      return;
    }
    out.check(k.kind === st.kind, `${at}.kind`, `impl "${st.impl}" is a "${k.kind}" stage, not "${st.kind}"`);

    const missingVars: string[] = [];
    const params = resolveVars(st.params, spec.vars, (n) => missingVars.push(n)) as Record<string, unknown>;
    missingVars.forEach((n) => out.invariant(`${at}.params`, `unknown variable \${vars.${n}}`));
    const validate = ajv.compile(k.params_schema);
    if (!validate(params)) issues.push(...ajvIssues(validate.errors, `${at}.params`));
    if (k.determinism === "seeded") out.check(params["seed"] !== undefined, `${at}.params.seed`, `"${st.impl}" is seeded: a seed is required`);

    for (const port of k.inputs) {
      const supplied = st.inputs[port.name];
      out.check(supplied !== undefined || port.optional === true, `${at}.inputs.${port.name}`, `required input port "${port.name}" is not connected`);
      if (supplied !== undefined) {
        out.check(Array.isArray(supplied) === (port.many === true), `${at}.inputs.${port.name}`, port.many ? "port is `many`: expected an array of refs" : "port takes a single ref, got an array");
      }
    }
    for (const name of Object.keys(st.inputs)) {
      out.check(k.inputs.some((p) => p.name === name), `${at}.inputs.${name}`, `"${st.impl}" has no input port "${name}"`);
    }
    for (const { port, ref, index } of refsOf(st.inputs)) {
      const want = k.inputs.find((p) => p.name === port)?.type;
      if (!want) continue;
      const edge = `${at}.inputs.${port}${index === null ? "" : `[${index}]`}`;
      if ("external" in ref) {
        const got = spec.externals?.[ref.external]?.type;
        if (got) out.check(got === want, edge, `external "${ref.external}" is ${got}, port expects ${want}`);
      } else {
        const src = stageKind.get(ref.stage);
        const outPort = src?.outputs.find((p) => p.name === ref.output);
        if (src && !outPort) out.invariant(edge, `stage "${ref.stage}" has no output port "${ref.output}"`);
        else if (outPort) out.check(outPort.type === want, edge, `"${ref.stage}.${ref.output}" is ${outPort.type}, port expects ${want}`);
      }
    }
  });
  return [...issues, ...out.list];
}
