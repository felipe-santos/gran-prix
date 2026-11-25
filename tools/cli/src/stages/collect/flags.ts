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
/**
 * `captcha` marks a CHALLENGE page (an interstitial in place of the page), not a page that mentions CAPTCHAs. The pattern must
 * match either (a) the `<title>`, anchored at its start on the phrases the interstitials use ("Just a moment...",
 * "Attention Required! | Cloudflare", "Checking your browser", "Robot Check", "Please verify you are human", "Pardon Our
 * Interruption", ...), or (b) the rendered text, and then the rendered text must be SHORT: an interstitial is a heading, one
 * or two sentences and a footer (Cloudflare managed challenge ~300 characters, hCaptcha ~300, Google's "unusual traffic"
 * page ~600), while a documentation page, a forum or a form with "protected by reCAPTCHA" has thousands. The limit leaves
 * ~30% headroom over the longest interstitial text and is not tuned on any sample. Before this rule (attempt 1 of the dom-v0
 * corpus) any occurrence in the text flagged docs and shops that merely talk about CAPTCHAs.
 */
export const CAPTCHA_TEXT_MAX_CHARS = 800;
const CAPTCHA_TITLE_RE = /^\s*(just a moment|attention required|checking your browser|verifying you are human|verify you are human|please verify|are you (a )?(human|robot)|robot check|human verification|security check|one more step|pardon our interruption|captcha (required|challenge|verification|check))/i;
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
  if (CAPTCHA_TITLE_RE.test(input.title ?? "") || (text.length < CAPTCHA_TEXT_MAX_CHARS && CAPTCHA_RE.test(text))) flags.push("captcha");
  if (PAYWALL_RE.test(text)) flags.push("paywall");
  if (input.nodes.length < 60 && (input.nodes[0]?.text_len ?? 0) < 800) flags.push("tiny-dom");
  return flags;
}
