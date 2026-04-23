// Pekacek Extension v2.0 — Background Service Worker
// Komunikuje s Claude Code pres lokalni bridge (WSL)
//
// Dva lokalni servery:
//   :3888 — Pekacek bridge (sidebar → Claude Code)
//   :3777 — Chrome Bookmarks MCP bridge (long-poll pro write operace zalozek)

const BRIDGE_URL = "http://localhost:3888";
const BOOKMARKS_MCP_URL = "http://localhost:3777";

// Toggle sidepanel on extension icon click (Chrome native behavior)
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("setPanelBehavior failed:", err));
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

// --- Chrome Bookmarks MCP bridge (long-poll) ---
// Keeps service worker alive with alarm, long-polls MCP server for commands.

chrome.alarms.create("bookmarks-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bookmarks-reconnect") bookmarksLongPoll();
});
chrome.runtime.onInstalled.addListener(() => bookmarksLongPoll());
chrome.runtime.onStartup.addListener(() => bookmarksLongPoll());

let bookmarksPolling = false;

async function bookmarksLongPoll() {
  if (bookmarksPolling) return;
  bookmarksPolling = true;

  try {
    const res = await fetch(`${BOOKMARKS_MCP_URL}/poll`);
    if (res.status === 200) {
      const command = await res.json();
      const result = await executeBookmarksCommand(command);
      await fetch(`${BOOKMARKS_MCP_URL}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      });
    }
    // 204 = timeout, reconnect
  } catch {
    // Server not running — wait before retry
    await new Promise((r) => setTimeout(r, 3000));
  }

  bookmarksPolling = false;
  bookmarksLongPoll();
}

async function executeBookmarksCommand(cmd) {
  try {
    switch (cmd.action) {
      case "createBookmark":
        return await chrome.bookmarks.create({
          title: cmd.title,
          url: cmd.url,
          parentId: cmd.parentId || "1",
        });
      case "createFolder":
        return await chrome.bookmarks.create({
          title: cmd.title,
          parentId: cmd.parentId || "1",
        });
      case "move":
        return await chrome.bookmarks.move(cmd.bookmarkId, {
          parentId: cmd.parentId,
          ...(cmd.index !== undefined && { index: cmd.index }),
        });
      case "delete":
        await chrome.bookmarks.remove(cmd.bookmarkId);
        return { success: true, deletedId: cmd.bookmarkId };
      case "update": {
        const changes = {};
        if (cmd.title) changes.title = cmd.title;
        if (cmd.url) changes.url = cmd.url;
        return await chrome.bookmarks.update(cmd.bookmarkId, changes);
      }
      default:
        return { error: `Unknown action: ${cmd.action}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// Start polling immediately (for existing service worker instances)
bookmarksLongPoll();

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
      const tab = tabs[0];
      console.log("[Pekacek] get-page-content for tab", tab.id, tab.url);

      chrome.tabs.sendMessage(tab.id, { type: "extract-content" }, (res) => {
        const err = chrome.runtime.lastError;
        if (!err && res) {
          console.log("[Pekacek] content script responded, length:", res.length);
          return sendResponse(res);
        }

        console.log("[Pekacek] content script not available, injecting:", err?.message);
        // Inject content script
        chrome.scripting.executeScript(
          { target: { tabId: tab.id }, files: ["content.js"] },
          (injectionResults) => {
            const injectErr = chrome.runtime.lastError;
            if (injectErr) {
              console.error("[Pekacek] inject failed:", injectErr.message);
              return sendResponse({
                error: `Nelze injektovat content script: ${injectErr.message}. Možná je stránka chráněna (chrome://, store, PDF...).`,
              });
            }
            console.log("[Pekacek] injected, retrying extraction");
            // Give content script time to register listener
            setTimeout(() => {
              chrome.tabs.sendMessage(tab.id, { type: "extract-content" }, (res2) => {
                const err2 = chrome.runtime.lastError;
                if (err2 || !res2) {
                  console.error("[Pekacek] retry failed:", err2?.message);
                  sendResponse({
                    error: err2?.message || "Content script nereagoval po injekci",
                  });
                } else {
                  console.log("[Pekacek] retry success, length:", res2.length);
                  sendResponse(res2);
                }
              });
            }, 500);
          }
        );
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

  // Badge notifications — sidebar completed a response while user was away
  if (msg.type === "response-done") {
    chrome.action.setBadgeText({ text: "●" });
    chrome.action.setBadgeBackgroundColor({ color: "#4ecca3" });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "clear-badge") {
    chrome.action.setBadgeText({ text: "" });
    sendResponse({ ok: true });
    return;
  }
});

// Clear badge when user clicks the toolbar icon (regardless of side panel open state)
chrome.action.onClicked.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
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
    return { error: "Složka _raw nenalezena v záložkách" };
  }

  const bookmark = await chrome.bookmarks.create({
    parentId: rawFolder.id,
    title: title || "Untitled",
    url,
  });

  return { success: true, id: bookmark.id };
}
