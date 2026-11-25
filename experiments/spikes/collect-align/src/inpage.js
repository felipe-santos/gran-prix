// In-page library (plain script, no modules): injected with context.addInitScript so it exists
// before any page script runs. Exposes window.__gp = { settle, stampIds, snapshot, applyTruth, ... }.
//
// Composed pre-order used everywhere (stamping, snapshot, text units), so ids and text order agree:
//   element -> its open shadow root children (if any) -> its light children
// Iframe documents are NOT entered (the <iframe> element itself is stamped). <template> content is
// a separate fragment and is never visited.
(() => {
  if (window.__gp) return;

  // --- mutation tracking since document start (used by settle) ---------------------------------
  const mut = { count: 0, last: performance.now(), shadowsSeen: new WeakSet() };
  const mo = new MutationObserver((list) => {
    mut.count += list.length;
    mut.last = performance.now();
  });
  const observe = (root) => {
    try {
      mo.observe(root, { childList: true, subtree: true, characterData: true });
    } catch (_) {}
  };
  observe(document);
  // attachShadow can happen at any time; observe open shadow roots as they are created.
  const origAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = origAttach.call(this, init);
    if (init && init.mode === 'open') observe(root);
    return root;
  };

  const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

  // --- composed pre-order walk ----------------------------------------------------------------
  function composedChildNodes(el) {
    const out = [];
    if (el.shadowRoot) for (const c of el.shadowRoot.childNodes) out.push(c);
    for (const c of el.childNodes) out.push(c);
    return out;
  }
  function composedParent(el) {
    const p = el.parentNode;
    if (!p) return null;
    if (p.nodeType === Node.ELEMENT_NODE) return p;
    if (p.nodeType === 11 && p.host) return p.host; // ShadowRoot -> host
    return null;
  }
  // visit(el) in pre-order; visitText(textNode, ownerEl, childIndex) interleaved in true document
  // order (a <p> with text, <a>, text yields p, text, a, text), so text units line up with extractor text.
  function walk(visit, visitText) {
    const stack = [{ n: document.documentElement }];
    while (stack.length) {
      const { n, owner, idx } = stack.pop();
      if (n.nodeType === Node.TEXT_NODE) { if (visitText) visitText(n, owner, idx); continue; }
      visit(n);
      const kids = composedChildNodes(n);
      const lightStart = n.shadowRoot ? n.shadowRoot.childNodes.length : 0;
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (k.nodeType === Node.ELEMENT_NODE) stack.push({ n: k });
        else if (k.nodeType === Node.TEXT_NODE && i >= lightStart) stack.push({ n: k, owner: n, idx: i - lightStart });
      }
    }
  }

  // --- settle: resolve once no DOM mutation happened for quietMs (or maxMs elapsed) -------------
  function settle({ quietMs = 600, maxMs = 8000 } = {}) {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        const now = performance.now();
        const quiet = now - mut.last;
        if (document.readyState === 'complete' && quiet >= quietMs) {
          return resolve({ reason: 'quiet', waitedMs: Math.round(now - t0), mutations: mut.count });
        }
        if (now - t0 >= maxMs) {
          return resolve({ reason: 'max', waitedMs: Math.round(now - t0), mutations: mut.count });
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  // --- stamping --------------------------------------------------------------------------------
  // Deterministic: id = "n" + pre-order index. Re-stamping overwrites, so it is idempotent for a
  // frozen DOM. Text nodes get no attribute; they are addressed as "<ownerId>#t<childIndex>".
  function stampIds() {
    let k = 0;
    walk((el) => el.setAttribute('data-gp-id', 'n' + k++));
    return k;
  }

  function countUnstamped() {
    let n = 0;
    walk((el) => { if (!el.hasAttribute('data-gp-id')) n++; });
    return n;
  }

  // --- snapshot ----------------------------------------------------------------------------------
  function ownTexts(el) {
    const out = [];
    if (SKIP_TEXT.has(el.tagName)) return out;
    el.childNodes.forEach((n, i) => {
      if (n.nodeType === Node.TEXT_NODE && n.nodeValue.trim()) out.push({ i, t: n.nodeValue });
    });
    return out;
  }
  function snapshot() {
    const elements = [];
    const texts = []; // flat, in composed document order
    const byId = new Map();
    const sx = window.scrollX, sy = window.scrollY;
    const vw = document.documentElement.scrollWidth, vh = document.documentElement.scrollHeight;
    walk((el) => {
      const id = el.getAttribute('data-gp-id');
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const own = ownTexts(el);
      const parent = composedParent(el);
      const rect = { x: Math.round(r.left + sx), y: Math.round(r.top + sy), w: Math.round(r.width), h: Math.round(r.height) };
      let shown = false;
      try { shown = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (_) {}
      const onCanvas = rect.x + rect.w > 0 && rect.y + rect.h > 0 && rect.x < vw && rect.y < vh;
      const rec = {
        id,
        tag: el.tagName.toLowerCase(),
        parent: parent ? parent.getAttribute('data-gp-id') : null,
        textLen: 0, // filled below (subtree text length)
        ownText: own.map((o) => o.t).join('').replace(/\s+/g, ' ').trim(),
        display: cs.display,
        visibility: cs.visibility,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        rect,
        visible: shown && rect.w > 0 && rect.h > 0 && onCanvas,
        cls: el.getAttribute('class') || '',
        inShadow: el.getRootNode() !== document,
        shadowHost: !!el.shadowRoot,
      };
      byId.set(id, rec);
      elements.push(rec);
    }, (tn, owner, idx) => {
      if (SKIP_TEXT.has(owner.tagName) || !tn.nodeValue.trim()) return;
      const oid = owner.getAttribute('data-gp-id');
      texts.push({ id: oid + '#t' + idx, owner: oid, t: tn.nodeValue });
    });
    // subtree text length: children appear after parents in pre-order, so a reverse pass suffices
    for (let i = elements.length - 1; i >= 0; i--) {
      const e = elements[i];
      e.textLen += e.ownText.length;
      const p = e.parent && byId.get(e.parent);
      if (p) p.textLen += e.textLen;
    }
    return {
      url: location.href,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight },
      doc: { w: vw, h: vh },
      elements,
      texts,
    };
  }

  // --- ground truth (fixtures only): nearest ancestor-or-self matching a rule; ties -> later rule
  function applyTruth(rules) {
    const out = {};
    walk((el) => {
      const id = el.getAttribute('data-gp-id');
      let cur = el, label = null, rule = -1;
      while (cur && label === null) {
        for (let r = rules.length - 1; r >= 0; r--) {
          let m = false;
          try { m = cur.matches(rules[r].selector); } catch (_) {}
          if (m) { label = rules[r].label; rule = r; break; }
        }
        cur = composedParent(cur);
      }
      out[id] = { label, rule };
    });
    return out;
  }

  // --- Readability on a clone of the stamped document ----------------------------------------------
  // The clone keeps data-gp-id attributes. cloneNode(true) does NOT copy shadow roots, so with
  // flattenShadow the open shadow content is inlined into the clone (attributes preserved).
  function cloneForReadability({ flattenShadow = false } = {}) {
    const clone = document.cloneNode(true);
    let flattened = 0;
    if (flattenShadow) {
      const hosts = [];
      walk((el) => { if (el.shadowRoot) hosts.push(el); });
      for (const host of hosts) {
        const target = clone.querySelector('[data-gp-id="' + host.getAttribute('data-gp-id') + '"]');
        if (!target) continue;
        const frag = clone.createDocumentFragment();
        for (const child of host.shadowRoot.childNodes) frag.append(clone.importNode(child, true));
        target.prepend(frag);
        flattened++;
      }
    }
    return { clone, flattened };
  }
  // Serialized stamped HTML with open shadow roots inlined (outerHTML alone drops shadow content).
  function flattenedHtml() {
    return cloneForReadability({ flattenShadow: true }).clone.documentElement.outerHTML;
  }
  function runReadability(opts = {}) {
    if (typeof Readability === 'undefined') return { error: 'Readability not loaded' };
    const { clone, flattened } = cloneForReadability(opts);
    let readerable = null;
    try { readerable = typeof isProbablyReaderable === 'function' ? isProbablyReaderable(document) : null; } catch (_) {}
    let article = null;
    try { article = new Readability(clone).parse(); } catch (e) { return { error: String(e) }; }
    if (!article) return { article: null, readerable, flattened };
    const doc = new DOMParser().parseFromString(article.content, 'text/html');
    const ids = Array.from(doc.querySelectorAll('[data-gp-id]')).map((n) => n.getAttribute('data-gp-id'));
    return {
      article: { title: article.title, byline: article.byline, length: article.length, text: article.textContent, html: article.content },
      ids,
      readerable,
      flattened,
    };
  }

  window.__gp = { settle, stampIds, countUnstamped, snapshot, applyTruth, runReadability, flattenedHtml, mutations: () => ({ count: mut.count, last: mut.last }) };
})();
