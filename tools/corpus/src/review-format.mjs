// The owner-review export: written by `review-page` (review.html), read and validated by `apply-review`.
export const REVIEW_FORMAT = "gran-prix.corpus-review/1";
/** `sim` = keep; `nao` and `duvida` both exclude (§2.1: ambiguous pages are excluded and recorded). */
export const ANSWERS = ["sim", "nao", "duvida"];
export const EXCLUDING = new Set(["nao", "duvida"]);
/** Why a page is excluded: [value, label shown in the page]. `outro` carries free text in `reason_text`. */
export const REASONS = [
  ["categoria-errada", "categoria errada"],
  ["erro-soft404", "erro ou soft-404"],
  ["login", "login"],
  ["desafio", "desafio (anti-bot/captcha)"],
  ["home-listagem", "home ou listagem"],
  ["outro", "outro (texto)"],
];
export const REASON_VALUES = new Set(REASONS.map(([v]) => v));
/** Used when the owner excludes a page without choosing a reason. */
export const NO_REASON = "sem-motivo";
