import type { LabelClass } from "./types.js";

/**
 * The calibration exercise of the annotation guide (section 7), as data and pure scoring.
 *
 * The owner labels, blind, the elements of 12 groups of the synthetic fixture pages (`fixtures/pages`, captured by
 * `collect`); the Studio compares with the expected label, which is NOT written here: it is the label the fixture's own
 * `truth.json` gives the element (guide revisions R1-R3 included), computed on the server and shown only after the
 * group is finished. A group is made of targets: a fixture and a CSS selector; the units are the elements with own
 * text (in U) at or below the elements the selector matches.
 *
 * Versioned definition: changing a group changes the exercise, so it goes through review like the guide does. The
 * test `calibration.test.ts` checks every target against the expected column of the guide's table.
 */

export interface CalTarget {
  fixture: string;
  selector: string;
  /** What the owner is told about the target (never the class). */
  what: string;
}

export interface CalGroup {
  /** 1..12, the row of the table in guide section 7. */
  n: number;
  title: string;
  targets: readonly CalTarget[];
}

const t = (fixture: string, selector: string, what: string): CalTarget => ({ fixture, selector, what });

export const CALIBRATION_GROUPS: readonly CalGroup[] = [
  { n: 1, title: "article-1: h1 e dek", targets: [t("article-1", "h1", "título da página"), t("article-1", ".dek", "subtítulo (dek)")] },
  {
    n: 2,
    title: "article-1: byline, legenda, tags, compartilhar, relacionados, modal",
    targets: [
      t("article-1", ".byline", "autor e data"),
      t("article-1", "figcaption", "legenda da figura"),
      t("article-1", ".tags", "tags"),
      t("article-1", ".share", "compartilhar"),
      t("article-1", ".related", "artigos relacionados"),
      t("article-1", "#subscribe-modal", "modal de assinatura"),
    ],
  },
  { n: 3, title: "article-1: comentários e botão de carregar mais", targets: [t("article-1", ".comments .comment", "texto dos comentários"), t("article-1", ".comments button", 'botão "Load more comments"')] },
  {
    n: 4,
    title: "article-2: índice, newsletter (Shadow DOM), texto invisível",
    targets: [t("article-2", ".toc", "índice"), t("article-2", "newsletter-box", "caixa de assinatura (Shadow DOM)"), t("article-2", ".stealth", "texto com visibility:hidden")],
  },
  {
    n: 5,
    title: "product-1: preço, estoque, variações, botões",
    targets: [
      t("product-1", ".price", "preço atual, preço riscado e selo de desconto"),
      t("product-1", ".stock", "estoque"),
      t("product-1", ".variants", "variações"),
      t("product-1", ".add", "adicionar ao carrinho"),
      t("product-1", ".wish", "lista de desejos"),
    ],
  },
  {
    n: 6,
    title: "product-1: avaliações, relacionados, selos, faixa do site",
    targets: [
      t("product-1", ".reviews", "avaliações"),
      t("product-1", ".related-products", "produtos relacionados"),
      t("product-1", ".trust li:nth-child(-n+2)", "dois primeiros itens da lista de selos (30-day returns, Two-year warranty)"),
      t("product-1", ".trust li:nth-child(3)", "terceiro item da lista de selos (Secure checkout)"),
      t("product-1", ".promo-bar", "faixa promocional do site"),
    ],
  },
  {
    n: 7,
    title: "product-2: especificações (Shadow DOM), entrega, opções, vídeo, chat",
    targets: [
      t("product-2", "product-specs", "especificações (Shadow DOM aberto)"),
      t("product-2", ".delivery", "entrega e devolução"),
      t("product-2", ".options", "opções"),
      t("product-2", ".video-note", "chamada do vídeo (o iframe não tem unidades)"),
      t("product-2", ".chat", "chat"),
    ],
  },
  {
    n: 8,
    title: "docs-1: código, breadcrumb, índice, árvore lateral, feedback, pager",
    targets: [
      t("docs-1", "article.doc > pre", "blocos de código"),
      t("docs-1", ".breadcrumbs", "breadcrumb"),
      t("docs-1", ".toc-right", '"On this page"'),
      t("docs-1", ".side", "árvore lateral"),
      t("docs-1", ".feedback", 'feedback e "Edit this page"'),
      t("docs-1", ".pager", "anterior e próximo"),
    ],
  },
  { n: 9, title: "docs-2: aviso de depreciação e veja também", targets: [t("docs-2", ".deprecated", "aviso de depreciação"), t("docs-2", ".see-also", "veja também")] },
  {
    n: 10,
    title: "forum-1: posts, assinatura, autor, ações do post, lateral",
    targets: [
      t("forum-1", ".post-text", "texto dos posts (original e respostas)"),
      t("forum-1", ".sig", "assinatura"),
      t("forum-1", ".author-col", "caixa do autor (nome, cargo, entrada, posts)"),
      t("forum-1", ".post-actions", 'ações do post ("Like (9)")'),
      t("forum-1", ".forum-side", "lateral do fórum"),
    ],
  },
  {
    n: 11,
    title: "forum-2: votos, autor, comentários, caixa de resposta",
    targets: [
      t("forum-2", ".votes div", 'placar e marca "Accepted"'),
      t("forum-2", ".votes button", "botões Up e Down"),
      t("forum-2", ".post-user", "quem perguntou ou respondeu"),
      t("forum-2", ".comments", "comentários"),
      t("forum-2", ".your-answer", "caixa de resposta"),
    ],
  },
  {
    n: 12,
    title: "landing-1 e landing-2: eyebrow, preços, depoimentos, funcionalidades, logos, CTA, popup, FAQ, lojas",
    targets: [
      t("landing-1", ".eyebrow", "eyebrow"),
      t("landing-1", "#pricing", "planos e preços"),
      t("landing-1", "#stories", "depoimentos"),
      t("landing-1", ".feature", "funcionalidades"),
      t("landing-1", ".logo-strip", "faixa de logos"),
      t("landing-1", ".cta-band", "faixa de CTA"),
      t("landing-1", ".fine", "microcopy do botão"),
      t("landing-1", "#beta-popup", "popup da beta"),
      t("landing-2", "#faq", "FAQ (details abertos)"),
      t("landing-2", ".stores", "selos de loja de aplicativos"),
    ],
  },
];

/** Pass criterion of guide section 7: 11 of 12 groups right in keep x drop, 10 of 12 in 3 classes. */
export const CALIBRATION_CRITERION = { groups: 12, binary: 11, three_class: 10 } as const;

/** Distinct fixtures of a group, in order of appearance. */
export const fixturesOf = (g: CalGroup): string[] => [...new Set(g.targets.map((x) => x.fixture))];
/** Distinct fixtures of the whole exercise. */
export const allFixtures = (): string[] => [...new Set(CALIBRATION_GROUPS.flatMap(fixturesOf))];

/** keep x drop (ADR-006): main and support are kept, noise is dropped. */
export const isKeep = (c: LabelClass): boolean => c !== "noise";

/** One unit of a group with its expected label. */
export interface UnitTruth {
  fixture: string;
  selector: string;
  unit_id: number;
  tag: string;
  text: string;
  expected: LabelClass;
}

export interface UnitJudged extends UnitTruth {
  given: LabelClass;
  binary_ok: boolean;
  three_ok: boolean;
}

export function judge(u: UnitTruth, given: LabelClass): UnitJudged {
  return { ...u, given, binary_ok: isKeep(u.expected) === isKeep(given), three_ok: u.expected === given };
}

export interface GroupResult {
  n: number;
  /** Units the owner labeled in the group. */
  n_units: number;
  /** Targets without any unit in U (hidden elements): nothing to label, correct by construction. */
  n_outside_targets: number;
  /** Every unit of the group right in keep x drop. */
  binary_ok: boolean;
  /** Every unit of the group right in main x support x noise. */
  three_ok: boolean;
  binary_errors: number;
  three_errors: number;
  /** The units wrong in 3 classes (the binary-wrong ones are among them), for discussion. */
  errors: UnitJudged[];
  finished_at: string;
}

export function scoreGroup(n: number, judged: readonly UnitJudged[], outsideTargets: number, finishedAt: string): GroupResult {
  const binaryErrors = judged.filter((j) => !j.binary_ok).length;
  const errors = judged.filter((j) => !j.three_ok);
  return { n, n_units: judged.length, n_outside_targets: outsideTargets, binary_ok: binaryErrors === 0, three_ok: errors.length === 0, binary_errors: binaryErrors, three_errors: errors.length, errors, finished_at: finishedAt };
}

export interface CalibrationSummary {
  total: number;
  finished: number;
  binary_correct: number;
  three_correct: number;
  binary_needed: number;
  three_needed: number;
  /** `null` until the 12 groups are finished; then whether both thresholds are met. */
  passed: boolean | null;
}

export function summarize(results: ReadonlyArray<Pick<GroupResult, "binary_ok" | "three_ok"> | null>): CalibrationSummary {
  const done = results.filter((r): r is Pick<GroupResult, "binary_ok" | "three_ok"> => r !== null);
  const binary = done.filter((r) => r.binary_ok).length;
  const three = done.filter((r) => r.three_ok).length;
  const complete = done.length === CALIBRATION_CRITERION.groups && results.length === CALIBRATION_CRITERION.groups;
  return {
    total: CALIBRATION_CRITERION.groups,
    finished: done.length,
    binary_correct: binary,
    three_correct: three,
    binary_needed: CALIBRATION_CRITERION.binary,
    three_needed: CALIBRATION_CRITERION.three_class,
    passed: complete ? binary >= CALIBRATION_CRITERION.binary && three >= CALIBRATION_CRITERION.three_class : null,
  };
}
