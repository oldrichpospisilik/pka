// Pekacek Extension v2.0 — Background Service Worker
// Komunikuje s Claude Code pres lokalni bridge (WSL)

const BRIDGE_URL = "http://localhost:3888";

// Open side panel on extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "open-sidepanel") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        await chrome.sidePanel.open({ tabId: tabs[0].id });
      }
    });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "get-tab-info") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return sendResponse({ error: "No active tab" });
      sendResponse({
        title: tabs[0].title || "",
        url: tabs[0].url || "",
        tabId: tabs[0].id,
      });
    });
    return true;
  }

  if (msg.type === "get-page-content") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return sendResponse({ error: "No active tab" });
      chrome.tabs.sendMessage(tabs[0].id, { type: "extract-content" }, (res) => {
        if (chrome.runtime.lastError || !res) {
          // Content script not injected — inject it now and retry
          chrome.scripting.executeScript(
            { target: { tabId: tabs[0].id }, files: ["content.js"] },
            () => {
              setTimeout(() => {
                chrome.tabs.sendMessage(tabs[0].id, { type: "extract-content" }, (res2) => {
                  sendResponse(res2 || { error: "Content script failed" });
                });
              }, 300);
            }
          );
        } else {
          sendResponse(res);
        }
      });
    });
    return true;
  }

  if (msg.type === "check-bridge") {
    checkBridge().then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.type === "save-to-raw") {
    saveToRawBookmarks(msg.url, msg.title).then(sendResponse);
    return true;
  }
});

// --- Bridge communication ---

async function checkBridge() {
  try {
    const res = await fetch(`${BRIDGE_URL}/status`);
    return await res.json();
  } catch {
    return { status: "offline" };
  }
}

// --- Save to _raw bookmarks folder ---

async function saveToRawBookmarks(url, title) {
  const results = await chrome.bookmarks.search({ title: "_raw" });
  const rawFolder = results.find((b) => b.url === undefined);

  if (!rawFolder) {
    return { error: "Slozka _raw nenalezena v zalozkach" };
  }

  const bookmark = await chrome.bookmarks.create({
    parentId: rawFolder.id,
    title: title || "Untitled",
    url,
  });

  return { success: true, id: bookmark.id };
}
