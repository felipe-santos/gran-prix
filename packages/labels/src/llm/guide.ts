import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The system prompt is BUILT from the frozen annotation guide (guia-de-anotacao.md, sections 1-4: "viram o
 * prompt de sistema"), never retyped. The guide file is read at run time, its whole-file sha256 is checked
 * against the pinned hash the caller passes (`prereg-dom-v0.txt`), and the sha256 of the final prompt text is
 * what `labeler.llm.prompt_sha256` and the cache keys record. Change one byte of the guide or of the
 * instructions below and every hash changes: nothing is relabeled silently.
 */

export const PROMPT_FORMAT = "dom-v0-llm-labeler@1" as const;

/** Instructions that follow the guide: input and output format of the protocol (section 5.3). */
export const OUTPUT_INSTRUCTIONS = `# Task

You label the text blocks of ONE web page. Apply the annotation guide above exactly: it is the only authority on what is principal (main), suporte (support) or ruido (noise).

You receive a user message with a page title, an optional category, and blocks in document order, one per line:

    n123|p|main>article>p|"collapsed text, up to a few hundred characters"

that is: block id | tag | ancestor path | quoted text. Lines under "CONTEXT" are shown only so you understand the page: do NOT label them. Lines under "BLOCKS" are the ones to label. You cannot see anything outside the text of the blocks (no styling, no other pages), so decide from the text, the tag and the path, with the guide's decision script (section 1.1).

Answer with ONE JSON object and nothing else:

    {"labels":[{"id":"n123","c":"M","u":false,"m":false}]}

- "id": the block id exactly as given. One entry for EVERY block under BLOCKS, no entry for CONTEXT blocks, no invented ids, no repeated ids.
- "c": "M" = principal (main), "S" = suporte (support), "N" = ruido (noise).
- "u": true when you are genuinely in doubt (the guide's "doubt" flag: real doubt between support and noise, or between main and support). It is not an excuse to skip the decision: "c" is always your best decision.
- "m": true when the block's own text mixes classes (guide section 2.4).
`;

export interface GuideSource {
  /** sha256 of the whole guide file, hex (the value pinned in `prereg-dom-v0.txt`). */
  guide_sha256: string;
  /** sha256 of the extracted sections 1-4, hex. */
  sections_sha256: string;
  /** Extracted text of sections 1-4, verbatim. */
  sections_text: string;
}

export interface SystemPrompt extends GuideSource {
  prompt_id: string;
  /** The exact system text sent to the model. */
  system: string;
  /** sha256 (`sha256:<hex>`) of `system`. */
  prompt_sha256: `sha256:${string}`;
}

const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

/** Text of sections 1..4: from the `## 1.` heading up to (not including) the `## 5.` heading. */
export function extractGuideSections(guide: string): string {
  const lines = guide.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^## 1\./.test(l));
  const end = lines.findIndex((l) => /^## 5\./.test(l));
  if (start < 0 || end < 0 || end <= start) throw new Error("the guide has no `## 1.` ... `## 5.` sections to build the prompt from");
  const text = lines.slice(start, end).join("\n").trimEnd();
  for (const n of [1, 2, 3, 4]) {
    if (!lines.slice(start, end).some((l) => new RegExp(`^## ${n}\\.`).test(l))) throw new Error(`guide section ${n} is missing`);
  }
  return text;
}

/** Reads the guide, checks its hash (when `expectedSha256` is given) and builds the system prompt. */
export function buildSystemPrompt(guidePath: string, expectedSha256: string | undefined, promptId: string = PROMPT_FORMAT): SystemPrompt {
  const bytes = readFileSync(guidePath);
  const guideSha = sha(bytes);
  const want = expectedSha256?.replace(/^sha256:/, "").toLowerCase();
  if (want !== undefined && want !== guideSha) {
    throw new Error(`the guide at ${guidePath} has sha256 ${guideSha}, not the pinned ${want}: the frozen guide changed (a deviation must be registered first)`);
  }
  return promptFromGuideText(bytes.toString("utf8"), guideSha, promptId);
}

export function promptFromGuideText(guide: string, guideSha256: string, promptId: string = PROMPT_FORMAT): SystemPrompt {
  const sections = extractGuideSections(guide);
  const system = `# Annotation guide (verbatim sections 1-4 of the frozen guide, sha256 ${guideSha256})\n\n${sections}\n\n${OUTPUT_INSTRUCTIONS}`;
  return {
    prompt_id: promptId,
    guide_sha256: guideSha256,
    sections_sha256: sha(sections),
    sections_text: sections,
    system,
    prompt_sha256: `sha256:${sha(system)}`,
  };
}
