/**
 * The local pages of the human steps of the QA study: a single static HTML file each, with the data embedded, inline
 * style and script, NO external resource (no font, no CDN, no request: it works from a file:// URL, offline). They hold
 * page text, so they live in the data dir (ignored by git) and are never published.
 *
 *  - `candidateReviewHtml` (protocol 9, "Validacao humana"): per page, each candidate that passed the automatic
 *    validators with the question, the answer and the evidence highlighted in the D2 text; three yes/no questions
 *    (answers from the page alone? unique? correct?), keyboard shortcuts for the 20 s budget, and an export of the
 *    decisions as JSON. Reserve candidates appear only when an earlier one of their kind was rejected.
 *  - `judgeReviewHtml` (protocol 9, "humano em >= 20%"): the sampled responses the LLM judge graded, WITHOUT the
 *    judge's verdict (no anchoring), to be marked correct / incorrect by a person.
 */

/** JSON that is safe inside a <script> element. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1b;--mut:#666;--bd:#cfd4da;--ok:#1a7f37;--no:#b42318;--hi:#fff3b0;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e8e8e8;--mut:#9aa0a6;--bd:#3a3f46;--ok:#4cc26b;--no:#ff7b72;--hi:#5b4b00;--card:#1c1f24}}
body{margin:0;padding:0 16px 80px;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--bd);padding:8px 0;z-index:2;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
h2{margin:24px 0 4px;font-size:16px}.meta{color:var(--mut);font-size:13px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:6px;padding:10px 12px;margin:10px 0}
.card.cur{outline:2px solid #3b82f6}.card.acc{border-left:5px solid var(--ok)}.card.rej{border-left:5px solid var(--no)}
.kind{font-size:12px;border:1px solid var(--bd);border-radius:10px;padding:0 8px;margin-right:6px}
.q{font-weight:600}.a{margin:2px 0}.ctx{white-space:pre-wrap;font:13px/1.4 ui-monospace,monospace;margin:6px 0;padding:6px;border:1px dashed var(--bd);overflow-wrap:anywhere}
mark{background:var(--hi);color:inherit}.row{display:flex;gap:6px;align-items:center;margin:3px 0;flex-wrap:wrap}.row span{min-width:230px}
button{font:inherit;border:1px solid var(--bd);background:var(--bg);color:var(--fg);border-radius:4px;padding:2px 10px;cursor:pointer}
button.on.y{background:var(--ok);color:#fff}button.on.n{background:var(--no);color:#fff}.adv{color:#b54708;font-size:13px}
textarea{width:100%;height:120px;font:12px ui-monospace,monospace}
`;

function shell(title: string, body: string, data: unknown, script: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head>
<body>${body}
<script type="application/json" id="data">${embedJson(data)}</script>
<script>${script}</script>
</body></html>
`;
}

// ------------------------------------------------------------------------------------------------------------- candidates

export interface ReviewPage {
  group_id: string;
  stratum: string;
  d2: string;
  candidates: Array<{ rank: number; kind: string; question: string; answer: string; answer_variants: string[]; quote: string; offset: number; advisory: string[] }>;
}

export interface ReviewData {
  candidates_id: string;
  kind_quota: Record<string, number>;
  pages: ReviewPage[];
}

const CANDIDATE_JS = `
(function(){
var data=JSON.parse(document.getElementById('data').textContent);
var KEY='gp-qa-review:'+data.candidates_id,state={},cur=null,reviewer='';
try{var s=localStorage.getItem(KEY);if(s){var o=JSON.parse(s);state=o.state||{};reviewer=o.reviewer||'';}}catch(e){}
function k(g,r){return g+'|'+r}
function dec(g,r){var d=state[k(g,r)]||{};if(d.a===false||d.u===false||d.c===false)return 'rej';if(d.a===true&&d.u===true&&d.c===true)return 'acc';return 'pend'}
function save(){try{localStorage.setItem(KEY,JSON.stringify({state:state,reviewer:reviewer}))}catch(e){}}
function visible(p){var out={},kinds={};p.candidates.forEach(function(c){(kinds[c.kind]=kinds[c.kind]||[]).push(c)});
Object.keys(kinds).forEach(function(kd){var q=data.kind_quota[kd]||0,shown=0,rej=0;kinds[kd].forEach(function(c){if(shown<q+rej){out[c.rank]=true;shown++;if(dec(p.group_id,c.rank)==='rej')rej++}})});return out}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
function set(g,r,a,u,c){state[k(g,r)]={a:a,u:u,c:c};save();renderPage(g)}
function toggle(g,r,f,v){var d=state[k(g,r)]||{a:null,u:null,c:null};var n={a:d.a,u:d.u,c:d.c};n[f]=(n[f]===v)?null:v;set(g,r,n.a,n.u,n.c)}
function card(p,c){var d=state[k(p.group_id,c.rank)]||{},st=dec(p.group_id,c.rank);
var e=el('div','card '+st+(cur===k(p.group_id,c.rank)?' cur':''));e.id='c-'+k(p.group_id,c.rank);
var h=el('div');h.appendChild(el('span','kind',c.kind));h.appendChild(el('span','meta','#'+c.rank+' - '+(st==='acc'?'accepted':st==='rej'?'rejected':'pending')));e.appendChild(h);
e.appendChild(el('div','q',c.question));
e.appendChild(el('div','a','Answer: '+c.answer+(c.answer_variants.length?'  (also: '+c.answer_variants.join(' | ')+')':'')));
c.advisory.forEach(function(a){e.appendChild(el('div','adv','note: '+a))});
var ctx=el('div','ctx'),A=Math.max(0,c.offset-300),B=Math.min(p.d2.length,c.offset+c.quote.length+300);
ctx.appendChild(document.createTextNode((A>0?'... ':'')+p.d2.slice(A,c.offset)));var m=el('mark',null,c.quote);ctx.appendChild(m);ctx.appendChild(document.createTextNode(p.d2.slice(c.offset+c.quote.length,B)+(B<p.d2.length?' ...':'')));e.appendChild(ctx);
[['a','Answerable from the page alone?'],['u','Is the answer unique?'],['c','Are answer and evidence correct?']].forEach(function(f){var row=el('div','row');row.appendChild(el('span',null,f[1]));
[[true,'Yes','y'],[false,'No','n']].forEach(function(o){var b=el('button','on-'+o[2]+(d[f[0]]===o[0]?' on '+o[2]:''),o[1]);b.className=(d[f[0]]===o[0]?'on '+o[2]:'');b.onclick=function(){cur=k(p.group_id,c.rank);toggle(p.group_id,c.rank,f[0],o[0])};row.appendChild(b)});e.appendChild(row)});
var q=el('div','row');var ba=el('button',null,'Accept (a)');ba.onclick=function(){cur=k(p.group_id,c.rank);set(p.group_id,c.rank,true,true,true)};var br=el('button',null,'Reject (r)');br.onclick=function(){cur=k(p.group_id,c.rank);set(p.group_id,c.rank,false,null,null)};q.appendChild(ba);q.appendChild(br);e.appendChild(q);
e.onclick=function(){cur=k(p.group_id,c.rank)};return e}
function renderPage(g){var p=data.pages.filter(function(x){return x.group_id===g})[0],box=document.getElementById('p-'+g),v=visible(p);box.textContent='';
box.appendChild(el('h2',null,p.stratum+' - '+p.group_id));
p.candidates.forEach(function(c){if(v[c.rank])box.appendChild(card(p,c))});stats()}
function stats(){var n=0,a=0,r=0;data.pages.forEach(function(p){var v=visible(p);p.candidates.forEach(function(c){if(v[c.rank]){n++;var s=dec(p.group_id,c.rank);if(s==='acc')a++;if(s==='rej')r++}})});document.getElementById('stats').textContent=a+' accepted, '+r+' rejected, '+(n-a-r)+' pending of '+n+' shown'}
function buildExport(){var d=[];data.pages.forEach(function(p){p.candidates.forEach(function(c){var s=state[k(p.group_id,c.rank)];if(s&&(s.a!==null||s.u!==null||s.c!==null))d.push({group_id:p.group_id,rank:c.rank,answers_from_page:s.a===undefined?null:s.a,unique:s.u===undefined?null:s.u,correct:s.c===undefined?null:s.c})})});
return {format:'gran-prix.qa-review',format_version:'1.0.0',candidates_id:data.candidates_id,reviewer:reviewer,decisions:d}}
window.__gpExport=buildExport;
var root=document.getElementById('pages');data.pages.forEach(function(p){var b=el('section');b.id='p-'+p.group_id;root.appendChild(b)});
data.pages.forEach(function(p){renderPage(p.group_id)});
var nm=document.getElementById('reviewer');nm.value=reviewer;nm.oninput=function(){reviewer=nm.value;save()};
document.getElementById('export').onclick=function(){var t=JSON.stringify(buildExport(),null,1),ta=document.getElementById('out');ta.value=t;ta.style.display='block';
try{var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([t],{type:'application/json'}));a.download='qa-review.json';document.body.appendChild(a);a.click();a.remove()}catch(e){}};
function flat(){var out=[];data.pages.forEach(function(p){var v=visible(p);p.candidates.forEach(function(c){if(v[c.rank])out.push([p,c])})});return out}
document.onkeydown=function(ev){if(ev.target&&(ev.target.tagName==='INPUT'||ev.target.tagName==='TEXTAREA'))return;var f=flat(),i=-1;f.forEach(function(x,j){if(k(x[0].group_id,x[1].rank)===cur)i=j});
if(ev.key==='j'||ev.key==='k'){i=ev.key==='j'?Math.min(f.length-1,i+1):Math.max(0,i-1);if(f[i]){cur=k(f[i][0].group_id,f[i][1].rank);renderPage(f[i][0].group_id);var e=document.getElementById('c-'+cur);if(e&&e.scrollIntoView)e.scrollIntoView({block:'center'})}}
else if((ev.key==='a'||ev.key==='r')&&f[i]){var p=f[i][0],c=f[i][1];if(ev.key==='a')set(p.group_id,c.rank,true,true,true);else set(p.group_id,c.rank,false,null,null);
var nx=flat();for(var j=0;j<nx.length;j++){if(dec(nx[j][0].group_id,nx[j][1].rank)==='pend'){cur=k(nx[j][0].group_id,nx[j][1].rank);renderPage(nx[j][0].group_id);var e2=document.getElementById('c-'+cur);if(e2&&e2.scrollIntoView)e2.scrollIntoView({block:'center'});break}}}};
})();
`;

export function candidateReviewHtml(data: ReviewData): string {
  const body = `<header><strong>QA candidate review</strong><span id="stats" class="meta"></span><label>Reviewer <input id="reviewer" size="14"></label><button id="export">Export JSON</button><span class="meta">j/k move, a accept, r reject (3 yes/no questions per candidate; accept = all yes)</span></header>
<textarea id="out" style="display:none" readonly></textarea><main id="pages"></main>`;
  return shell("QA candidate review", body, data, CANDIDATE_JS);
}

// ------------------------------------------------------------------------------------------------------------- judge sample

export interface JudgeReviewData {
  sample_id: string;
  items: Array<{ task_id: string; arm: string; question: string; answer: string; answer_variants: string[]; response: string }>;
}

const JUDGE_JS = `
(function(){
var data=JSON.parse(document.getElementById('data').textContent),KEY='gp-qa-judge:'+data.sample_id,state={},reviewer='',cur=0;
try{var s=localStorage.getItem(KEY);if(s){var o=JSON.parse(s);state=o.state||{};reviewer=o.reviewer||'';}}catch(e){}
function k(i){return i.task_id+'|'+i.arm}
function save(){try{localStorage.setItem(KEY,JSON.stringify({state:state,reviewer:reviewer}))}catch(e){}}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
function render(){var root=document.getElementById('items'),n=0;root.textContent='';
data.items.forEach(function(it,idx){var v=state[k(it)];if(v)n++;var c=el('div','card'+(v==='correct'?' acc':v==='incorrect'?' rej':'')+(idx===cur?' cur':''));c.id='c-'+idx;
c.appendChild(el('div','q',it.question));c.appendChild(el('div','a','Key: '+it.answer+(it.answer_variants.length?'  (also: '+it.answer_variants.join(' | ')+')':'')));
c.appendChild(el('div','ctx',it.response===''?'(empty response)':it.response));var row=el('div','row');
[['correct','Correct (c)','y'],['incorrect','Incorrect (i)','n']].forEach(function(o){var b=el('button',v===o[0]?'on '+o[2]:'',o[1]);b.onclick=function(){cur=idx;state[k(it)]=(state[k(it)]===o[0]?undefined:o[0]);save();render()};row.appendChild(b)});
c.appendChild(row);c.onclick=function(){cur=idx};root.appendChild(c)});
document.getElementById('stats').textContent=n+' of '+data.items.length+' graded'}
function buildExport(){var d=[];data.items.forEach(function(it){var v=state[k(it)];if(v)d.push({task_id:it.task_id,arm:it.arm,verdict:v})});return {format:'gran-prix.qa-judge-review',format_version:'1.0.0',sample_id:data.sample_id,reviewer:reviewer,verdicts:d}}
window.__gpExport=buildExport;
var nm=document.getElementById('reviewer');nm.value=reviewer;nm.oninput=function(){reviewer=nm.value;save()};
document.getElementById('export').onclick=function(){var t=JSON.stringify(buildExport(),null,1),ta=document.getElementById('out');ta.value=t;ta.style.display='block';
try{var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([t],{type:'application/json'}));a.download='qa-judge-review.json';document.body.appendChild(a);a.click();a.remove()}catch(e){}};
document.onkeydown=function(ev){if(ev.target&&(ev.target.tagName==='INPUT'||ev.target.tagName==='TEXTAREA'))return;var it=data.items[cur];if(!it)return;
if(ev.key==='c'||ev.key==='i'){state[k(it)]=ev.key==='c'?'correct':'incorrect';save();if(cur<data.items.length-1)cur++;render();var e=document.getElementById('c-'+cur);if(e&&e.scrollIntoView)e.scrollIntoView({block:'center'})}
else if(ev.key==='j'&&cur<data.items.length-1){cur++;render()}else if(ev.key==='k'&&cur>0){cur--;render()}};
render();
})();
`;

export function judgeReviewHtml(data: JudgeReviewData): string {
  const body = `<header><strong>QA judge sample</strong><span id="stats" class="meta"></span><label>Reviewer <input id="reviewer" size="14"></label><button id="export">Export JSON</button><span class="meta">c correct, i incorrect, j/k move. The judge's verdict is hidden on purpose.</span></header>
<textarea id="out" style="display:none" readonly></textarea><main id="items"></main>`;
  return shell("QA judge sample", body, data, JUDGE_JS);
}
