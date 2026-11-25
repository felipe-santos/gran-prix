// review.html: a static, self-contained page for the owner to check the corpus by eye (opens in VS Code or any browser).
// No external resource: inline CSS and JS, images by path relative to the data dir (screens/...). Answers are kept in
// localStorage and exported as JSON. Local only, never published; it lives in the gitignored data dir.
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { CATEGORIES } from "./config.mjs";
import { readJsonlSync } from "./jsonl.mjs";
import { firstTwenty } from "./report.mjs";
import { effectiveRecords } from "./state.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const SOURCE = { wcxb: "WCXB", webmainbench: "WebMainBench" };
/** Exclusions that rest on one of the corpus heuristics (not on an HTTP/robots fact): the ones a human can disagree with. */
export const isRuleDecided = (r) => r.outcome === "excluded" && /^(language:|out-of-scope-type$|personal-profile$|pii-evident$|adult-content$|flag:captcha$|flag:error-page$|flag:paywall$)/.test(r.reason);

const ANSWERS = (kind) =>
  kind === "accepted"
    ? [["", "(categoria correta?)"], ["sim", "sim"], ["nao", "não"], ["duvida", "dúvida"]]
    : [["", "(exclusão correta?)"], ["sim", "sim, correta"], ["nao", "não, indevida"], ["duvida", "dúvida"]];

function card(section, r, shotRel, lines, kind) {
  const key = `${section}|${r.category}|${r.url}`;
  const img = shotRel ? `<a href="${esc(shotRel)}" target="_blank"><img loading="lazy" src="${esc(shotRel)}" alt="screenshot"></a>` : `<div class="noshot">sem screenshot</div>`;
  const opts = ANSWERS(kind).map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join("");
  return `<article class="card" data-key="${esc(key)}" data-section="${esc(section)}" data-url="${esc(r.url)}" data-category="${esc(r.category)}">
  ${img}
  <div class="meta"><span class="cat">${esc(r.category)}</span> <a class="url" href="${esc(r.url)}" target="_blank" rel="noreferrer noopener">${esc(r.url)}</a>
  ${lines.map((l) => `<div class="line">${l}</div>`).join("\n  ")}
  <select class="ans">${opts}</select> <input class="note" type="text" placeholder="nota (opcional)"></div>
</article>`;
}

/** Pure: records (effective walked records) -> html. `shot(r)` gives the screenshot path relative to the page, or null. */
export function buildReviewHtml(records, shot = (r) => r.screenshot ?? null, generatedAt = new Date().toISOString()) {
  const accepted = records.filter((r) => r.outcome === "accepted");
  const { any, flagged } = firstTwenty(records);
  const ruleDecided = records.filter(isRuleDecided).sort((a, b) => a.seq - b.seq);

  const excl = (section, r) =>
    card(section, r, shot(r), [
      `motivo: <code>${esc(r.reason)}</code>${r.also?.length ? ` (também: ${r.also.map((x) => `<code>${esc(x)}</code>`).join(", ")})` : ""}`,
      `http: ${esc(r.detail?.http_status ?? r.detail?.server_status ?? "n/d")} · flags: ${esc((r.detail?.flags ?? []).join(", ") || "nenhuma")} · chars visíveis: ${esc(r.detail?.visible_chars ?? "n/d")} · idioma: ${esc(r.detail?.lang ?? "n/d")}${r.detail?.html_lang ? ` (html lang ${esc(r.detail.html_lang)}; detector ${esc((r.detail.lang_top ?? []).join(", "))})` : ""}`,
      r.detail?.title ? `título: ${esc(r.detail.title)}` : "",
    ].filter(Boolean), "excluded");

  const secA = CATEGORIES.map((c) => {
    const rows = accepted.filter((r) => r.category === c.name).sort((a, b) => a.seq - b.seq);
    return `<h3 id="a-${c.name}">${esc(c.name)} <small>(${rows.length} de ${c.n})</small></h3><div class="grid">
${rows.map((r) => card("A", r, shot(r), [`fonte: <b>${esc(SOURCE[r.source_dataset] ?? r.source_dataset)}</b> (${esc(r.source_type)}) · fase: ${esc(r.phase)}`, r.detail?.title ? `título: ${esc(r.detail.title)}` : "", `idioma: ${esc(r.detail?.lang)} · chars visíveis: ${esc(r.detail?.visible_chars)}`].filter(Boolean), "accepted")).join("\n")}
</div>`;
  }).join("\n");

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Conferência do corpus dom-v0</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f23;--mut:#586069;--line:#d0d7de;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--line:#30363d;--card:#161b22}}
body{margin:0 auto;max-width:1400px;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:22px}h2{margin-top:36px;border-bottom:1px solid var(--line);padding-bottom:6px}h3{margin:24px 0 8px}small{color:var(--mut);font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;overflow:hidden;display:flex;flex-direction:column}
.card img{display:block;width:100%;height:190px;object-fit:cover;object-position:top}.noshot{height:60px;display:flex;align-items:center;justify-content:center;color:var(--mut)}
.meta{padding:8px 10px;word-break:break-word}.cat{background:var(--line);border-radius:10px;padding:1px 8px;font-size:12px}.url{font-size:12px}.line{color:var(--mut);font-size:12px;margin-top:3px}
.ans{margin-top:8px}.note{margin-top:8px;width:55%}.card.done{outline:2px solid #2da44e}.card.bad{outline:2px solid #cf222e}.card.maybe{outline:2px solid #bf8700}
nav{position:sticky;top:0;background:var(--bg);padding:8px 0;border-bottom:1px solid var(--line);z-index:5}button{padding:4px 10px}
code{background:var(--line);padding:0 4px;border-radius:3px}
</style></head><body>
<h1>Conferência do corpus dom-v0</h1>
<p>Gerado em ${esc(generatedAt)}. Arquivo local (nunca publicado). Suas respostas ficam no navegador (localStorage) e saem em JSON pelo botão. Nada é decidido por esta página: ela só coleta o seu veredito.</p>
<nav><button id="export">exportar JSON</button> <button id="clear">limpar respostas</button> <span id="count"></span>
 · <a href="#secA">A. Aceitas (${accepted.length})</a> · <a href="#secB">B. Primeiras 20 exclusões</a> · <a href="#secC">C. Decididas pela regra (${ruleDecided.length})</a></nav>
<h2 id="secA">A. Aceitas <small>a categoria atribuída está certa pela URL e pelo screenshot?</small></h2>
${secA}
<h2 id="secB">B. Primeiras 20 exclusões <small>o protocolo manda conferir à mão</small></h2>
<h3>B1. As 20 primeiras exclusões, de qualquer motivo, na ordem da caminhada</h3><div class="grid">
${any.map((r) => excl("B1", r)).join("\n")}
</div>
<h3>B2. As 20 primeiras decididas pelo detector de flags (status HTTP, erro, captcha, paywall)</h3><div class="grid">
${flagged.length ? flagged.map((r) => excl("B2", r)).join("\n") : "<p>nenhuma</p>"}
</div>
<h2 id="secC">C. Exclusões decididas pela regra <small>idioma, tipo fora do escopo, perfil/PII, adulto, captcha: um humano pode discordar</small></h2><div class="grid">
${ruleDecided.length ? ruleDecided.map((r) => excl("C", r)).join("\n") : "<p>nenhuma</p>"}
</div>
<script>
(function(){
  var KEY="gp-corpus-review-v0", cards=[].slice.call(document.querySelectorAll(".card"));
  var store={}; try{store=JSON.parse(localStorage.getItem(KEY)||"{}");}catch(e){}
  function save(){try{localStorage.setItem(KEY,JSON.stringify(store));}catch(e){}}
  function paint(c){var v=(store[c.dataset.key]||{}).answer||"";c.classList.toggle("done",v==="sim");c.classList.toggle("bad",v==="nao");c.classList.toggle("maybe",v==="duvida");}
  function count(){var n=0;cards.forEach(function(c){if((store[c.dataset.key]||{}).answer)n++;});document.getElementById("count").textContent=n+" de "+cards.length+" respondidas";}
  cards.forEach(function(c){
    var s=c.querySelector(".ans"), t=c.querySelector(".note"), cur=store[c.dataset.key]||{};
    s.value=cur.answer||""; t.value=cur.note||""; paint(c);
    function upd(){store[c.dataset.key]={answer:s.value,note:t.value};save();paint(c);count();}
    s.addEventListener("change",upd); t.addEventListener("input",upd);
  });
  count();
  document.getElementById("export").addEventListener("click",function(){
    var rows=cards.map(function(c){var a=store[c.dataset.key]||{};return {section:c.dataset.section,category:c.dataset.category,url:c.dataset.url,answer:a.answer||"",note:a.note||""};});
    var blob=new Blob([JSON.stringify({exported_at:new Date().toISOString(),answers:rows},null,2)],{type:"application/json"});
    var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="corpus-v0-review-answers.json";document.body.appendChild(a);a.click();a.remove();
  });
  document.getElementById("clear").addEventListener("click",function(){if(confirm("Apagar todas as respostas?")){store={};save();cards.forEach(function(c){c.querySelector(".ans").value="";c.querySelector(".note").value="";paint(c);});count();}});
})();
</script></body></html>
`;
}

export async function reviewPage(dataDir) {
  const records = effectiveRecords(readJsonlSync(join(dataDir, "walked.jsonl")));
  const html = buildReviewHtml(records, (r) => (r.screenshot ? relative(dataDir, r.screenshot) : null));
  await writeFile(join(dataDir, "review.html"), html);
  const n = records.filter((r) => r.outcome === "accepted").length;
  console.log(`review.html: ${n} accepted, ${records.filter(isRuleDecided).length} rule-decided exclusions`);
}
