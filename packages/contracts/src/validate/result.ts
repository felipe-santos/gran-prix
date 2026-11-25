export type IssueCode =
  | "schema" // shape: required/type/pattern/range (from JSON Schema)
  | "version" // unknown format or unsupported MAJOR
  | "invariant" // cross-field rule that JSON Schema cannot express
  | "id-mismatch" // a content id does not match the recomputed hash
  | "lint"; // runtime-compat warning promoted to error (e.g. BatchNorm on the wasm trainer)

export interface ContractIssue {
  code: IssueCode;
  contract: string;
  /** Field path, e.g. `features[3].range` or `$` for the root. */
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T; issues: [] } | { ok: false; issues: ContractIssue[] };

/** Thrown by `assertValid`. `issues` are the structured findings. */
export class ContractError extends Error {
  readonly issues: ContractIssue[];
  constructor(contract: string, issues: ContractIssue[]) {
    const first = issues[0];
    super(
      `${contract}: ${issues.length} issue(s); first: ${first ? `${first.path}: ${first.message}` : "?"}`,
    );
    this.name = "ContractError";
    this.issues = issues;
  }
}

/** Collector used by invariant checkers. */
export class Issues {
  readonly list: ContractIssue[] = [];
  constructor(private readonly contract: string) {}
  add(code: IssueCode, path: string, message: string): void {
    this.list.push({ code, contract: this.contract, path, message });
  }
  invariant(path: string, message: string): void {
    this.add("invariant", path, message);
  }
  /** A content id must equal its recomputed value. */
  idCheck(cond: boolean, path: string, message: string): void {
    if (!cond) this.add("id-mismatch", path, message);
  }
  /** `cond` must hold, otherwise an invariant issue is recorded. */
  check(cond: boolean, path: string, message: string): void {
    if (!cond) this.invariant(path, message);
  }
}

/** `/features/3/range` -> `features[3].range`; empty -> `$`. */
export function pointerToPath(pointer: string): string {
  if (pointer === "") return "$";
  return pointer
    .split("/")
    .slice(1)
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc === "" ? seg : `${acc}.${seg}`), "");
}
