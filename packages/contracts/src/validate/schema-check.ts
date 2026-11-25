import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { jsonSchemaOf } from "../jsonschema.js";
import type { ContractName } from "../registry.js";
import { pointerToPath, type ContractIssue } from "./result.js";

// strict: true makes Ajv reject unknown keywords and ambiguous schemas, so a
// contract that Ajv accepts is also unambiguous for other validators.
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
// `x-gran-prix` is our own metadata keyword (contract name / format / version).
ajv.addKeyword("x-gran-prix");
const compiled = new Map<ContractName, ValidateFunction>();

function validatorFor(name: ContractName): ValidateFunction {
  let v = compiled.get(name);
  if (!v) {
    v = ajv.compile(jsonSchemaOf(name));
    compiled.set(name, v);
  }
  return v;
}

function describe(e: ErrorObject): { path: string; message: string } {
  let path = pointerToPath(e.instancePath);
  const p = e.params as Record<string, unknown>;
  const join = (prop: string): string => (path === "$" ? prop : `${path}.${prop}`);
  switch (e.keyword) {
    case "required":
      path = join(String(p["missingProperty"]));
      return { path, message: "is required" };
    case "additionalProperties":
      path = join(String(p["additionalProperty"]));
      return { path, message: "is not allowed here" };
    case "const":
      return { path, message: `must be ${JSON.stringify(p["allowedValue"])}` };
    case "enum":
      return { path, message: `must be one of ${JSON.stringify(p["allowedValues"])}` };
    case "anyOf":
      return { path, message: "does not match any allowed variant" };
    default:
      return { path, message: e.message ?? `failed ${e.keyword}` };
  }
}

/** JSON Schema validation only (shape). Returns [] when the value conforms. */
export function checkSchema(name: ContractName, value: unknown): ContractIssue[] {
  const validate = validatorFor(name);
  if (validate(value)) return [];
  const seen = new Set<string>();
  const issues: ContractIssue[] = [];
  for (const e of validate.errors ?? []) {
    const { path, message } = describe(e);
    const key = `${path}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ code: "schema", contract: name, path, message });
  }
  return issues;
}
