// What the reused collector code imports from `@gran-prix/contracts`, WITHOUT its validators (Ajv compiles schemas
// with `new Function`, which the MV3 CSP forbids). Validation happens in `gp-corpus import-captures`.
export { sha256Of, sha256Hex } from "../../../../packages/contracts/dist/identity/hash.js";
export { canonicalJson } from "../../../../packages/contracts/dist/identity/canonical-json.js";
export { contractId } from "../../../../packages/contracts/dist/identity/contract-ids.js";
