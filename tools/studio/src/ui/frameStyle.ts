/**
 * Stylesheet injected into the sandboxed page frame. Every class is readable WITHOUT colour: a fill pattern, an
 * outline style and a letter badge (M / S / N) each carry the class on their own. Palette: Okabe-Ito, safe for the common
 * colour-vision deficiencies.
 *
 *   main    solid outline,  diagonal stripes,  badge M, vermillion
 *   support dashed outline, dots,              badge S, blue
 *   noise   dotted outline, horizontal lines,  badge N, grey
 *   unlabeled unit: orange double outline (what is still to do)
 */
export const CLASS_COLORS = { main: "#b34700", support: "#0072b2", noise: "#595959" } as const;

export const FRAME_CSS = `
html{scroll-behavior:auto}
[data-gp-u]{cursor:pointer}
[data-gp-cls="main"]{outline:2px solid #b34700;outline-offset:-1px;background-image:repeating-linear-gradient(45deg,rgba(179,71,0,.2) 0 3px,transparent 3px 8px)!important}
[data-gp-cls="support"]{outline:2px dashed #0072b2;outline-offset:-1px;background-image:radial-gradient(rgba(0,114,178,.5) 1.2px,transparent 1.6px)!important;background-size:7px 7px!important}
[data-gp-cls="noise"]{outline:2px dotted #595959;outline-offset:-1px;background-image:repeating-linear-gradient(0deg,rgba(89,89,89,.22) 0 2px,transparent 2px 6px)!important}
[data-gp-cls="none"]{outline:2px double #e69f00;outline-offset:-1px}
[data-gp-ex="main"]{box-shadow:inset 3px 0 0 #b34700}
[data-gp-ex="support"]{box-shadow:inset 3px 0 0 #0072b2}
[data-gp-ex="noise"]{box-shadow:inset 3px 0 0 #595959}
[data-gp-dis]{box-shadow:0 0 0 3px #cc0000!important}
[data-gp-dim]{opacity:.35}
[data-gp-hover]{box-shadow:0 0 0 3px rgba(240,200,0,.95)!important}
[data-gp-in-sel]{filter:saturate(1.15) brightness(.97)}
[data-gp-sel]{box-shadow:0 0 0 3px #000,0 0 0 6px #fff!important}
[data-gp-forced]{display:block!important;visibility:visible!important;opacity:1!important;height:auto!important;max-height:none!important;position:static!important;clip:auto!important;overflow:visible!important}
#gp-studio-layer{position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none}
#gp-studio-layer span{position:absolute;transform:translate(-2px,-9px);font:700 11px/13px ui-monospace,Menlo,Consolas,monospace;color:#fff;padding:0 4px;border-radius:2px;white-space:nowrap;border:1px solid #fff}
#gp-studio-layer span.main{background:#b34700}
#gp-studio-layer span.support{background:#0072b2}
#gp-studio-layer span.noise{background:#595959}
#gp-studio-layer span.ghost{background:#fff;color:#222;border:1px dashed #222}
#gp-studio-layer span.dis{outline:2px solid #cc0000}
#gp-studio-layer span.collapsed{font-style:italic}
`;
