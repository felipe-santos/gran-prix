// The action behind the toolbar click: inject the collector's probe into the tab, build the snapshot, download the pair.
// Permissions used: activeTab (granted by the click), scripting (executeScript), downloads. No network, no remote code.
import { baseNameOf, buildCapture, gzipText, SETTLE } from "./build-capture.js";
import { pageProbe, pageTakeFlat } from "./page-probe.js";

export const DOWNLOAD_DIR = "gp-captures";

export class CaptureFailure extends Error {}

/** Full Chrome version ("131.0.6778.86") when userAgentData reports it; the UA only has the reduced "131.0.0.0". */
async function fullBrowserVersion() {
  try {
    const high = await navigator.userAgentData?.getHighEntropyValues(["fullVersionList"]);
    const list = high?.fullVersionList ?? [];
    return (list.find((b) => b.brand === "Google Chrome") ?? list.find((b) => b.brand === "Chromium"))?.version;
  } catch {
    return undefined;
  }
}

function base64Of(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** data: URL download (a service worker has no object URLs). Resolves when the browser finished writing the file. */
async function downloadBytes(name, bytes, mime) {
  const id = await chrome.downloads.download({
    url: `data:${mime};base64,${base64Of(bytes)}`,
    filename: `${DOWNLOAD_DIR}/${name}`,
    conflictAction: "overwrite",
    saveAs: false,
  });
  await new Promise((resolve, reject) => {
    const onChanged = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === "complete") done(resolve);
      else if (d.state.current === "interrupted") done(() => reject(new CaptureFailure(`o download de ${name} foi interrompido (${d.error?.current ?? "?"})`)));
    };
    const done = (fn) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      fn();
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then((items) => {
      const s = items[0]?.state;
      if (s === "complete") done(resolve);
      else if (s === "interrupted") done(() => reject(new CaptureFailure(`o download de ${name} foi interrompido`)));
    });
  });
  return id;
}

/**
 * @param {number} tabId
 * @returns {Promise<{ snapshotId: string, nodes: number, bytes: number, files: string[], flags: string[] }>}
 */
export async function captureTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url) throw new CaptureFailure("sem permissão para esta aba: clique no ícone da extensão com a página aberta (chrome://, a Chrome Web Store e arquivos locais não podem ser capturados)");
  if (!/^https?:\/\//i.test(tab.url)) throw new CaptureFailure("só páginas http(s) podem ser capturadas (chrome://, arquivos locais e about:blank não)");

  const inject = async (details) => {
    try {
      return await chrome.scripting.executeScript({ target: { tabId }, ...details });
    } catch (e) {
      throw new CaptureFailure(`não consegui rodar na aba (${e instanceof Error ? e.message : String(e)}); clique no ícone da extensão com a página aberta`);
    }
  };

  await inject({ files: ["gp-features.iife.js"] });
  const probed = (await inject({ func: pageProbe, args: [SETTLE] }))[0]?.result;
  if (!probed) throw new CaptureFailure("o probe não devolveu resultado");
  await inject({ files: ["flatten-page.js"] });
  const flat = (await inject({ func: pageTakeFlat }))[0]?.result;
  if (!flat) throw new CaptureFailure("a página não pôde ser serializada");

  const built = buildCapture({
    raw: probed.raw,
    flat,
    userAgent: probed.userAgent,
    browserVersion: await fullBrowserVersion(),
    status: probed.status,
  });
  const base = baseNameOf(built.snapshot.snapshot_id);
  const gz = await gzipText(built.html);
  const json = new TextEncoder().encode(built.snapshotText);
  await downloadBytes(`${base}.json`, json, "application/json");
  await downloadBytes(`${base}.html.gz`, gz, "application/gzip");
  return {
    snapshotId: built.snapshot.snapshot_id,
    nodes: built.snapshot.nodes.length,
    bytes: json.length + gz.length,
    files: [`${DOWNLOAD_DIR}/${base}.json`, `${DOWNLOAD_DIR}/${base}.html.gz`],
    flags: built.flags,
  };
}
