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
  const clone = document.cloneNode(true);
  const hosts = [];
  const collect = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) { hosts.push(el); collect(el.shadowRoot); }
    }
  };
  collect(document);
  let inlined = 0;
  for (const host of hosts) {
    const id = host.getAttribute("data-gp-id");
    if (!id) continue;
    const target = clone.querySelector('[data-gp-id="' + id + '"]');
    if (!target) continue;
    const frag = clone.createDocumentFragment();
    for (const child of host.shadowRoot.childNodes) frag.append(clone.importNode(child, true));
    target.prepend(frag);
    inlined++;
  }
  // Scripts are emptied, not removed: every probed element (scripts included) keeps its data-gp-id.
  for (const s of Array.from(clone.querySelectorAll("script"))) {
    for (const a of Array.from(s.attributes)) if (a.name !== "data-gp-id") s.removeAttribute(a.name);
    s.textContent = "";
  }
  const doctype = clone.doctype ? "<!DOCTYPE " + clone.doctype.name + ">" : "";
  return { html: doctype + clone.documentElement.outerHTML, shadow_hosts_inlined: inlined };
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
