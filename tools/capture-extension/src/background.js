// Service worker. The popup asks for a capture by message; the work runs here so that it finishes even if the popup closes.
import { captureTab, CaptureFailure } from "./capture-tab.js";

// Same function the click ends up calling; the Playwright test drives it directly (activeTab cannot be granted by automation).
self.gpCaptureTab = captureTab;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "gp-capture" || !Number.isInteger(msg.tabId)) return false;
  captureTab(msg.tabId).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e instanceof CaptureFailure ? e.message : `erro inesperado: ${e instanceof Error ? e.message : String(e)}` }),
  );
  return true; // async response
});
