/**
 * The report's single stylesheet (inlined into <style>). System font stack only: nothing is fetched.
 * One accent for the model, neutral grays for baselines. PASS/FAIL carry text and an icon, so color
 * is never the only signal. Light and dark follow `prefers-color-scheme`.
 */
export const CSS = `
:root{color-scheme:light dark;--bg:#fff;--surface:#f5f6f8;--text:#14171c;--muted:#566070;--border:#d5dae2;--accent:#1a56db;--accent-soft:#e6eefc;--g1:#374151;--g2:#6b7280;--g3:#8791a1;--g4:#4b5563;--pass:#0b6636;--pass-bg:#e4f4ea;--fail:#a01919;--fail-bg:#fbe8e8;--warn:#7a4b00;--warn-bg:#fdf1d9}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--surface:#161a21;--text:#e8ebf0;--muted:#a1abb9;--border:#2b323d;--accent:#7ca8ff;--accent-soft:#17243f;--g1:#d3d8e0;--g2:#a0a9b7;--g3:#7e8899;--g4:#bcc3ce;--pass:#86dba8;--pass-bg:#12301f;--fail:#ff9d9d;--fail-bg:#3b1717;--warn:#f2c46d;--warn-bg:#35280d}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:1040px;margin:0 auto;padding:20px 16px 56px;overflow-wrap:anywhere}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 4px}
h2{font-size:1.15rem;margin:0 0 12px;padding-top:4px}
h3{font-size:.95rem;margin:20px 0 8px}
p{margin:0 0 10px}
code,.mono{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
section{margin:0;padding:28px 0 4px;border-top:1px solid var(--border)}
header.top{padding-bottom:16px}
.eyebrow{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 14px}
ul.toc{display:flex;flex-wrap:wrap;gap:6px 14px;margin:14px 0 0;padding:0;list-style:none;font-size:.85rem}
ul.toc a{color:var(--accent)}
a{color:var(--accent)}
dl.kv{display:grid;grid-template-columns:minmax(120px,max-content) 1fr;gap:6px 16px;margin:0}
dl.kv dt{color:var(--muted)}
dl.kv dd{margin:0}
details.prov{margin-top:14px;border:1px solid var(--border);border-radius:8px;padding:10px 14px;background:var(--surface)}
details.prov summary{cursor:pointer;font-weight:600}
details.prov dl.kv{margin-top:10px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px;margin:0 0 16px}
.tile{border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--surface)}
.tile .l{color:var(--muted);font-size:.75rem;display:block}
.tile .v{font-size:1.15rem;font-weight:650;font-variant-numeric:tabular-nums}
.banner{display:flex;align-items:center;gap:10px;border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin:0 0 14px;font-weight:600}
.banner.pass{background:var(--pass-bg);color:var(--pass);border-color:var(--pass)}
.banner.fail{background:var(--fail-bg);color:var(--fail);border-color:var(--fail)}
.banner.warn{background:var(--warn-bg);color:var(--warn);border-color:var(--warn)}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 0 12px;border:1px solid var(--border);border-radius:8px}
table{border-collapse:collapse;width:100%;min-width:540px;font-size:.88rem;overflow-wrap:normal}
table code{overflow-wrap:anywhere}
caption{text-align:left;color:var(--muted);padding:8px 10px;caption-side:top;font-size:.82rem}
th,td{padding:6px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
thead th{background:var(--surface);font-weight:600;white-space:nowrap}
tbody tr:last-child td,tbody tr:last-child th{border-bottom:0}
tbody.grp+tbody.grp>tr:first-child>*{border-top:2px solid var(--border)}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.n .ci{display:block;color:var(--muted);font-size:.76rem}
td.sys{white-space:nowrap}
tr.model td,tr.model th{font-weight:650}
tr.model td:first-child,tr.model th:first-child{box-shadow:inset 3px 0 0 var(--accent)}
.sw{display:inline-block;vertical-align:-2px;margin-right:6px}
.badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 10px 2px 7px;font-weight:700;font-size:.8rem;white-space:nowrap;border:1px solid currentColor}
.badge svg{width:13px;height:13px;flex:none}
.badge.pass{color:var(--pass);background:var(--pass-bg)}
.badge.fail{color:var(--fail);background:var(--fail-bg)}
.badge.na{color:var(--muted);background:var(--surface)}
.muted{color:var(--muted)}
.absent{color:var(--muted);font-style:italic;margin:0 0 10px}
.note-line{color:var(--muted);font-size:.82rem;margin:0 0 12px}
.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:16px;margin:0 0 12px}
.panel{border:1px solid var(--border);border-radius:8px;padding:10px 12px 6px;background:var(--bg);min-width:0}
.panel h3{margin:0 0 4px}
.panel .cap{color:var(--muted);font-size:.78rem;margin:0 0 4px}
svg.chart{display:block;width:100%;height:auto;max-width:520px;margin:0 auto}
svg.chart text{font-family:inherit}
.tick{font-size:10px;fill:var(--muted)}
.axl{font-size:10.5px;fill:var(--muted);font-weight:600}
.rowl{font-size:11px;fill:var(--text);font-weight:650}
.dlab{font-size:10.5px;fill:var(--text);font-weight:600}
.grid{stroke:var(--border);stroke-width:1}
.sep{stroke:var(--border);stroke-width:1;stroke-dasharray:2 3}
.axis{stroke:var(--muted);stroke-width:1.2}
.zero{stroke:var(--text);stroke-width:1.2;stroke-dasharray:4 3}
.s0{--c:var(--accent)}.s1{--c:var(--g1)}.s2{--c:var(--g2)}.s3{--c:var(--g3)}.s4{--c:var(--g4)}
.mk{fill:var(--c);stroke:var(--bg);stroke-width:1.5}
.mk.x{fill:none;stroke:var(--c);stroke-width:2.2}
.wh line{stroke:var(--c);stroke-width:2.2;stroke-linecap:butt}
.ln{fill:none;stroke:var(--c);stroke-width:2.2;stroke-linejoin:round}
.ln.dashed{stroke-dasharray:5 4;stroke-width:1.4;stroke:var(--muted)}
.ring{fill:none;stroke:var(--c);stroke-width:1.6}
ul.legend{display:flex;flex-wrap:wrap;gap:4px 16px;list-style:none;margin:0 0 10px;padding:0;font-size:.82rem}
ul.legend li{display:inline-flex;align-items:center;gap:6px}
.cm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:16px}
table.cm{width:100%;min-width:0;table-layout:fixed;margin:0 auto;font-size:.85rem}
table.cm th,table.cm td{white-space:normal;overflow-wrap:anywhere;text-align:center;border:1px solid var(--border);padding:6px 4px;overflow-wrap:normal}
table.cm td{background:color-mix(in srgb,var(--accent) calc(var(--v,0)*55%),transparent)}
table.cm td b{display:block;font-size:1rem;font-variant-numeric:tabular-nums}
table.cm td span{font-size:.76rem;color:var(--muted);font-variant-numeric:tabular-nums}
table.cm td.hit{outline:2px solid var(--accent);outline-offset:-2px}
.notes{margin:0;padding:0;list-style:none;display:grid;gap:8px}
.notes li{border:1px solid var(--border);border-left-width:4px;border-radius:6px;padding:8px 12px;background:var(--surface)}
.notes li.threat{border-left-color:var(--warn)}
.notes li.note{border-left-color:var(--accent)}
.kind{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-right:8px;color:var(--muted)}
footer{margin-top:32px;padding-top:14px;border-top:1px solid var(--border);color:var(--muted);font-size:.8rem}
@media (max-width:520px){main{padding:14px 16px 40px}h1{font-size:1.3rem}dl.kv{grid-template-columns:1fr;gap:0}dl.kv dd{margin-bottom:8px}}
@media print{body{background:#fff;color:#000}section{break-inside:avoid}details.prov{display:block}}
`;
