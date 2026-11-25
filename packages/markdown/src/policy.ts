import type { CollapsedPolicy } from "./types.js";

/**
 * DECISION (frozen with the converters, protocol 13): is the content of a COLLAPSED DISCLOSURE (`flags.disclosure`:
 * closed `<details>`, inactive tabpanel, accordion panel) part of D2 and of the pruned output?
 *
 * "exclude". Reasons:
 *  1. Protocol 10 says D2 removes "elementos nao renderizados", and the snapshot contract itself calls this content
 *     "not rendered, but part of U". Taken literally, it goes.
 *  2. D2 is "propositalmente o piso conservador: o denominador mais pequeno possivel da a razao mais honesta".
 *     Excluding it gives the smallest D2.
 *  3. It is consistent downstream: the QA questions are generated from D2 (protocol 9), so no question has its
 *     evidence in collapsed content, and the pruned arms are measured against the same text the questions came from.
 *
 * The cost: a system that keeps a collapsed unit gets no output for it (its text is not emitted). Nothing downstream
 * measures that content, and the stage reports D2 with the collapsed content as a sensitivity column
 * (`tokens_d2_collapsed`), so the effect on the headline ratio is visible, never hidden.
 */
export const COLLAPSED_CONTENT_IN_D2: CollapsedPolicy = "exclude";
