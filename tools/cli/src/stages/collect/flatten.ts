import { gzipSync } from "node:zlib";
import { sha256Of, type FileRef } from "@gran-prix/contracts";

/**
 * Expression evaluated in the LIVE page after the probe has stamped `data-gp-id` on every element.
 * It serializes a clone of the document:
 *
 *  - every OPEN shadow root is inlined (its children are prepended to the host, in the composed
 *    pre-order the ids use), because `outerHTML` and `cloneNode` drop shadow content (spike: on MDN
 *    55% of the text lives in shadow roots);
 *  - every `data-gp-id` attribute is kept (inlined content carries its ids too);
 *  - every `<script>` element is emptied (no source, no attributes but its `data-gp-id`): the file is only
 *    ever parsed, never executed, and page code stays out of the stored text. The element itself stays
 *    because the probe numbers it (the snapshot has a node for it, and every snapshot id must be present).
 *
 * Not inlined: closed shadow roots, iframe documents and `<template>` content (the probe does not
 * enter them either, so they have no ids). Kept as a string because this package has no DOM lib.
 */
export const FLATTEN_SOURCE = `(() => {
  // Clobber-proof and Trusted-Types-proof (attempt 2 of the dom-v0 corpus). The page can shadow properties of its own
  // elements and of \`document\` with named controls (<form><input name="shadowRoot">, <img name="cloneNode">), and a
  // document with \`require-trusted-types-for 'script'\` rejects \`script.textContent = ""\`. So every read goes through the
  // getters and methods taken from the prototypes here (a minimal copy of packages/features/src/probe/dom.ts: this expression
  // runs after the page's scripts, in a separate evaluate, so it cannot share the bundle's closure), and scripts are emptied by
  // removing their child nodes, which is not a Trusted Types sink.
  const get = (proto, key) => Object.getOwnPropertyDescriptor(proto, key).get;
  const E = Element.prototype, N = Node.prototype, D = Document.prototype, F = DocumentFragment.prototype;
  const shadowRootOf = get(E, "shadowRoot"), attributesOf = get(E, "attributes"), outerHTMLOf = get(E, "outerHTML");
  const childNodesOf = get(N, "childNodes"), firstChildOf = get(N, "firstChild"), nodeTypeOf = get(N, "nodeType");
  const docElOf = get(D, "documentElement"), doctypeOf = get(D, "doctype"), doctypeNameOf = get(DocumentType.prototype, "name");
  const attrNameOf = get(Attr.prototype, "name");
  const getAttr = E.getAttribute, removeAttr = E.removeAttribute, prepend = E.prepend;
  const cloneNode = N.cloneNode, removeChild = N.removeChild;
  const qsDoc = D.querySelector, qsaDoc = D.querySelectorAll, createFragment = D.createDocumentFragment, importNode = D.importNode;
  const qsaFrag = F.querySelectorAll, append = F.append;
  const qsa = (root, sel) => (nodeTypeOf.call(root) === 9 ? qsaDoc : qsaFrag).call(root, sel);

  const clone = cloneNode.call(document, true);
  const hosts = [];
  const collect = (root) => {
    for (const el of qsa(root, "*")) {
      const sr = shadowRootOf.call(el);
      if (sr) { hosts.push(el); collect(sr); }
    }
  };
  collect(document);
  let inlined = 0;
  for (const host of hosts) {
    const id = getAttr.call(host, "data-gp-id");
    if (!id) continue;
    const target = qsDoc.call(clone, '[data-gp-id="' + id + '"]');
    if (!target) continue;
    const frag = createFragment.call(clone);
    for (const child of childNodesOf.call(shadowRootOf.call(host))) append.call(frag, importNode.call(clone, child, true));
    prepend.call(target, frag);
    inlined++;
  }
  // Scripts are emptied, not removed: every probed element (scripts included) keeps its data-gp-id.
  for (const s of Array.from(qsaDoc.call(clone, "script"))) {
    for (const a of Array.from(attributesOf.call(s))) { const n = attrNameOf.call(a); if (n !== "data-gp-id") removeAttr.call(s, n); }
    let c;
    while ((c = firstChildOf.call(s))) removeChild.call(s, c);
  }
  const dt = doctypeOf.call(clone);
  const doctype = dt ? "<!DOCTYPE " + doctypeNameOf.call(dt) + ">" : "";
  return { html: doctype + outerHTMLOf.call(docElOf.call(clone)), shadow_hosts_inlined: inlined };
})()`;

export interface FlattenedPage {
  html: string;
  shadow_hosts_inlined: number;
}

/** Gzip with a fixed level; the id of the snapshot hashes the DECODED html, so zlib builds cannot change it. */
export function gzipHtml(html: string): Uint8Array {
  return new Uint8Array(gzipSync(Buffer.from(html, "utf8"), { level: 9 }));
}

/**
 * FileRef of the stored html. `sha256` / `bytes` describe the DECODED document (the `.gz` bytes differ
 * between zlib builds and must not leak into `snapshot_id`); `content_encoding` (extension of the open
 * FileRef schema) tells readers the stored file is gzip.
 */
export function htmlFileRef(path: string, html: string): FileRef & { content_encoding: "gzip" } {
  return { path, sha256: sha256Of(html), bytes: Buffer.byteLength(html, "utf8"), media_type: "text/html", content_encoding: "gzip" };
}
