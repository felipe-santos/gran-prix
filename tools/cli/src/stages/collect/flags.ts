/**
 * Cheap "this is not the page you wanted" heuristics (ported from the collect-align spike's
 * `pageFlags`). They are HINTS recorded in `capture.flags`, outside the snapshot id: a labeler or the
 * dataset stage decides what to do with flagged pages; the collector never drops them silently.
 */
export const PAGE_FLAGS = ["http-error", "error-page", "captcha", "paywall", "tiny-dom"] as const;
export type PageFlag = (typeof PAGE_FLAGS)[number];

/** The fields of a snapshot node the heuristics read (structurally a subset of `SnapNode`). */
export interface FlagNode {
  parent: number;
  own_text: string;
  text_len: number;
  style: { display: string; visibility: string };
}

export interface FlagInput {
  title?: string | undefined;
  http_status: number;
  /** The snapshot's pre-order node table. */
  nodes: readonly FlagNode[];
}

const ERROR_RE = /too many requests|rate limit|access denied|forbidden|service unavailable|error 4\d\d|error 5\d\d/i;
const CAPTCHA_RE = /captcha|verify you are human|just a moment|checking your browser|unusual traffic/i;
const PAYWALL_RE = /subscribe to (continue|read)|sign in to (continue|read)|create a free account to read|you have reached your (free )?limit/i;

/** Own text of the nodes that are rendered: a hidden subscribe modal is not a paywall. Pre-order, so parents come first. */
function visibleText(nodes: readonly FlagNode[]): string {
  const hidden: boolean[] = [];
  const parts: string[] = [];
  for (const n of nodes) {
    const h = n.style.display === "none" || n.style.visibility === "hidden" || (n.parent >= 0 && hidden[n.parent] === true);
    hidden.push(h);
    if (!h && n.own_text !== "") parts.push(n.own_text);
  }
  return parts.join(" ");
}

export function pageFlags(input: FlagInput): PageFlag[] {
  const text = visibleText(input.nodes);
  const head = `${input.title ?? ""} ${text.slice(0, 600)}`;
  const flags: PageFlag[] = [];
  if (input.http_status >= 400) flags.push("http-error");
  if (ERROR_RE.test(head)) flags.push("error-page");
  if (CAPTCHA_RE.test(text)) flags.push("captcha");
  if (PAYWALL_RE.test(text)) flags.push("paywall");
  if (input.nodes.length < 60 && (input.nodes[0]?.text_len ?? 0) < 800) flags.push("tiny-dom");
  return flags;
}
