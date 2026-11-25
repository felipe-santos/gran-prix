// Popup: capture the active tab as soon as it opens (the click on the icon is the whole interaction) and say what happened.
const statusEl = document.getElementById("status");
const detailEl = document.getElementById("detail");
const againEl = document.getElementById("again");

/** `?tab=<id>` is for the automated test (the popup page is then opened as a tab); a real popup uses the active tab. */
async function targetTabId() {
  const forced = new URLSearchParams(location.search).get("tab");
  if (forced) return Number(forced);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function run() {
  againEl.hidden = true;
  statusEl.className = "";
  statusEl.textContent = "Capturando… (alguns segundos)";
  detailEl.textContent = "";
  const tabId = await targetTabId();
  if (!Number.isInteger(tabId)) {
    statusEl.className = "error";
    statusEl.textContent = "Nenhuma aba ativa.";
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "gp-capture", tabId });
  if (res?.ok) {
    const kb = Math.max(1, Math.round(res.result.bytes / 1024));
    statusEl.textContent = `capturado: ${res.result.nodes} nós, ${kb} KB`;
    detailEl.textContent = `Downloads/${res.result.files[0]}${res.result.flags.length > 0 ? ` (avisos: ${res.result.flags.join(", ")})` : ""}`;
  } else {
    statusEl.className = "error";
    statusEl.textContent = "Não capturou.";
    detailEl.textContent = res?.error ?? "sem resposta da extensão";
  }
  againEl.hidden = false;
}

againEl.addEventListener("click", run);
run();
