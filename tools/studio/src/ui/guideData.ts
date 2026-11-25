/**
 * Quick reference of the annotation guide (IDEIAS/plano/guia-de-anotacao.md, v1.0-draft): a SUMMARY for use while
 * labeling, with the section numbers to look up. The guide is the authority and is frozen; do not extend these lines
 * with rules of your own, change the guide through its errata process instead.
 */

export const GUIDE_FILE = "IDEIAS/plano/guia-de-anotacao.md";

export const GUIDE_QUESTION = "If an LLM answered questions about THIS page, could this text be needed?";

export const CLASS_SUMMARY: ReadonlyArray<{ cls: "main" | "support" | "noise"; key: string; text: string }> = [
  { cls: "main", key: "1", text: "the purpose of the page: its object and what describes or develops it. Would be in a 3-sentence summary." },
  { cls: "support", key: "2", text: "belongs to this page and qualifies, contextualizes or verifies the main text (author, date, caption, breadcrumb, reviews, comments, TOC)." },
  { cls: "noise", key: "3", text: "everything else: site frame, nav, ads, promos, controls and buttons, widgets, footers, and anything about OTHER pages or entities." },
];

export const DECISION_ORDER: readonly string[] = [
  "Rendered (or a content disclosure)? If not, it is outside U: nothing to label.",
  "A control or UI action (button, field, menu, pagination, share, like, cookie, popup)? Noise.",
  "About another page, another entity, or a promotion (related, most read, ads)? Noise.",
  "Answers the page's central purpose? Main.",
  "Belongs here but qualifies/verifies the main? Support.",
  "None of the above: noise.",
];

export const TIE_BREAKS: readonly string[] = [
  "Real doubt between support and noise: support + flag d (doubt).",
  "Doubt between main and support: main only if it would be in the 3-sentence summary, else support.",
  "A mixed element (own text mixes classes): the highest class with a substantive part, flag m (mixed); label a child separately when you can.",
  "Counts inside a control's text (Like (9)) stay with the control: noise.",
];

export interface CategoryGuide {
  id: string;
  title: string;
  section: string;
  main: string;
  support: string;
  noise: string;
  cases: readonly string[];
}

export const CATEGORIES: readonly CategoryGuide[] = [
  {
    id: "article",
    title: "Article / blog post",
    section: "4.1",
    main: "title, dek, body, subheads, lists, tables, code, the article's own blockquote",
    support: "byline, dates, kicker, captions and credits, tags, author bio, TOC, comments, references, breadcrumb",
    noise: "header/nav, share, most read, related, newsletter, ads, cookie, subscribe modal, footer",
    cases: ["Load more comments button: noise (it is a control).", "A pull quote repeating a body sentence: noise.", "The h1 equal to the title: main."],
  },
  {
    id: "product",
    title: "E-commerce product page",
    section: "4.2",
    main: "title, tagline, PRICE (current, struck, discount badge, tax note), description, specs (even collapsed or in Shadow DOM)",
    support: "breadcrumb, rating and reviews, Q&A, stock, concrete shipping/returns, variants, SKU, seller, instalments",
    noise: "add to cart, wishlist, quantity, compare, generic trust badges, site promo bar, related / also bought, chat, popups, footer",
    cases: ["Concrete returns/warranty (30 days, 2 years): support; 'Secure checkout': noise.", "Related products are noise even with title and price."],
  },
  {
    id: "docs",
    title: "Technical documentation",
    section: "4.3",
    main: "h1, lead, headings, paragraphs, parameter tables, CODE BLOCKS (always)",
    support: "breadcrumb, 'On this page', admonitions (note/warning/deprecated), a visible version notice, code-tab labels",
    noise: "sidebar tree (incl. the current item), top bar, search, version selector, 'Was this helpful', 'Edit this page', prev/next, 'See also', Copy buttons",
    cases: ["Code tabs (curl, Python): every panel is main, the tab label is support.", "A hidden version banner is outside U."],
  },
  {
    id: "forum",
    title: "Forum / Q&A thread",
    section: "4.4",
    main: "thread title and the body of EVERY post: the original and each reply, on an equal footing",
    support: "thread meta, forum breadcrumb, post date, author box, tags, vote score and 'Accepted' mark, comments under a post",
    noise: "signatures, post actions (Quote, Report, Like (n)), vote buttons, ads, pagination, reply box, similar threads, who is online, header/footer",
    cases: ["Never judge the quality of a reply: all main.", "Author box in one element (name, rank, joined, posts): support + flag m."],
  },
  {
    id: "landing",
    title: "Landing page",
    section: "4.5",
    main: "hero title and subtitle, features/benefits (title + description), how it works, product description",
    support: "eyebrow, pricing plans, testimonials (quote + attribution), FAQ (open or closed), integrations, short case studies",
    noise: "nav, CTA buttons and the microcopy glued to them, logo strip, repeated CTA bands, app-store badges, counters, newsletter, popups, footer",
    cases: ["Pricing is support, not main.", "A wall of logos or '10,000 teams' with no claim: noise."],
  },
  {
    id: "spa",
    title: "SPA and apps",
    section: "4.6",
    main: "public content SPA: as the content type shows it. Logged-in app: the primary panel (open email, note, task, chart values)",
    support: "item metadata (sender, date, status, owner, labels), comments and activity, path/folder; late-loaded sections count",
    noise: "app bar, drawers, folder trees, toolbars, menus, filters, badges, composer, onboarding, any list outside the primary panel, loading states, toasts",
    cases: ["Measured after the settle: late sections are in U.", "Logged-in pages: labeled by a human only, locally."],
  },
];

export const TRANSVERSAL: readonly string[] = [
  "Inline elements (a, strong, em, span, code...) inherit from the block; label them apart only when they are a control or another thing inside main text.",
  "Label the highest homogeneous container, then fix the exceptions below it (nearest explicit label wins).",
  "Iframe content is opaque: no units, nothing to label. A social-embed blockquote in the DOM inside an article: support.",
  "Cookie, consent, newsletter, paywall call-to-action, ads, sponsored: noise.",
];
