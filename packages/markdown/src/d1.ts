/**
 * D1 (protocol 10): the `outerHTML` of `documentElement` of the rendered, settled DOM, WITHOUT the `data-gp-*`
 * attributes, inline `<script>` and `<style>` included.
 *
 * The stored html of a snapshot (`html.gz`) is that serialization with three known differences (see the README):
 *  - it carries `data-gp-id` on every element: removed here;
 *  - `<script>` elements are EMPTIED by the collector (content and attributes dropped): D1 undercounts inline scripts,
 *    so a D1 taken from the snapshot is a lower bound of the protocol's D1 (conservative: the ratio is smaller);
 *  - open Shadow DOM is INLINED (a real `outerHTML` drops it): D1 counts content the page shows and `outerHTML` would
 *    not (it makes D1 larger on pages with shadow roots; the number of shadow nodes is reported next to D1).
 *
 * The attributes are removed by a scanner over the serialized text, not by a parse and re-serialize: every other byte
 * of the document is untouched, so D1 is exactly the stored serialization minus the attributes.
 */

/** Elements whose content is raw text in the HTML serialization: no tags inside, scan to the matching end tag. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"]);
const END_TAG = new Map<string, RegExp>();
const endTagRe = (tag: string): RegExp => {
  let re = END_TAG.get(tag);
  if (!re) {
    re = new RegExp(`</${tag}(?=[\\s/>])`, "gi");
    END_TAG.set(tag, re);
  }
  return re;
};

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d;
const isAlpha = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** Removes every attribute whose name starts with `data-gp-` (case-insensitive) from the start tags of `html`. */
export function stripGpAttributes(html: string): string {
  const n = html.length;
  const out: string[] = [];
  let copied = 0; // html[0, copied) is already in `out`
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    const c1 = html.charCodeAt(lt + 1);
    if (c1 === 0x21 /* ! */ || c1 === 0x3f /* ? */) {
      // comment, doctype, CDATA-ish, processing instruction: skip to its end
      const comment = html.startsWith("<!--", lt);
      const end = comment ? html.indexOf("-->", lt + 4) : html.indexOf(">", lt + 2);
      i = end < 0 ? n : end + (comment ? 3 : 1);
      continue;
    }
    if (c1 === 0x2f /* / */) {
      const gt = html.indexOf(">", lt + 2);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (!isAlpha(c1)) {
      i = lt + 1; // a literal "<" (cannot come out of a serializer; harmless)
      continue;
    }
    // start tag: name, then attributes up to ">"
    let p = lt + 1;
    while (p < n && !isSpace(html.charCodeAt(p)) && html[p] !== "/" && html[p] !== ">") p++;
    const tag = html.slice(lt + 1, p).toLowerCase();
    let selfClosing = false;
    for (;;) {
      const wsStart = p;
      while (p < n && isSpace(html.charCodeAt(p))) p++;
      if (p >= n) break;
      const c = html[p];
      if (c === ">") {
        p++;
        break;
      }
      if (c === "/") {
        selfClosing = html[p + 1] === ">";
        p += selfClosing ? 2 : 1;
        if (selfClosing) break;
        continue;
      }
      const nameStart = p;
      while (p < n && !isSpace(html.charCodeAt(p)) && html[p] !== "=" && html[p] !== ">" && html[p] !== "/") p++;
      const name = html.slice(nameStart, p);
      let q = p;
      while (q < n && isSpace(html.charCodeAt(q))) q++;
      if (html[q] === "=") {
        q++;
        while (q < n && isSpace(html.charCodeAt(q))) q++;
        const quote = html[q];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, q + 1);
          q = close < 0 ? n : close + 1;
        } else {
          while (q < n && !isSpace(html.charCodeAt(q)) && html[q] !== ">") q++;
        }
        p = q;
      }
      if (name.length >= 8 && name.slice(0, 8).toLowerCase() === "data-gp-") {
        out.push(html.slice(copied, wsStart)); // drop the attribute and the whitespace before it
        copied = p;
      }
    }
    i = p;
    if (!selfClosing && RAW_TEXT.has(tag)) {
      const re = endTagRe(tag);
      re.lastIndex = p;
      const m = re.exec(html);
      i = m ? m.index : n;
    }
  }
  if (copied === 0) return html;
  out.push(html.slice(copied));
  return out.join("");
}

/** D1 of a stored (flattened, `data-gp-id`-stamped) html: the document element only (no doctype), without `data-gp-*`. */
export function d1Html(storedHtml: string): string {
  return stripGpAttributes(storedHtml).replace(/^\s*<!doctype[^>]*>\s*/i, "");
}
