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
      notifyMcpActivity(command, "start");
      let result;
      try {
        result = await executeBookmarksCommand(command);
      } finally {
        notifyMcpActivity(command, "done");
      }
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

// Broadcast MCP activity to sidebar so it can show "Pekáček dělá X" indicator.
// Send only minimal summary — full command/result can be huge (screenshots, HTML).
function notifyMcpActivity(command, status) {
  if (!command || !command.action) return;
  try {
    const summary = {
      url: command.url,
      selector: command.selector,
      tabId: command.tabId,
    };
    chrome.runtime.sendMessage(
      { type: "mcp-activity", action: command.action, status, summary },
      () => { void chrome.runtime.lastError; /* sidebar not open = OK */ }
    );
  } catch {}
}

async function executeBookmarksCommand(cmd) {
  try {
    switch (cmd.action) {
      // --- Bookmarks ---
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

      // --- Tabs: inspection ---
      case "listTabs": {
        const tabs = await chrome.tabs.query({});
        return {
          tabs: tabs.map((t) => ({
            id: t.id,
            windowId: t.windowId,
            url: t.url,
            title: t.title,
            active: t.active,
            pinned: t.pinned,
            audible: t.audible,
            favIconUrl: t.favIconUrl,
          })),
        };
      }
      case "getActiveTab": {
        const t = await getActiveTab();
        if (!t) return { error: "No active tab" };
        return {
          id: t.id,
          windowId: t.windowId,
          url: t.url,
          title: t.title,
          favIconUrl: t.favIconUrl,
        };
      }
      case "screenshotActive": {
        const t = await getActiveTab();
        if (!t) return { error: "No active tab" };
        const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, {
          format: "png",
        });
        const dataBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        return { dataBase64, tabId: t.id, url: t.url, title: t.title };
      }

      // --- DOM: read ---
      case "readPageText": {
        const tabId = await resolveTabId(cmd.tabId);
        return await sendContentMessage(tabId, { type: "extract-content" });
      }
      case "readPageHtml": {
        const tabId = await resolveTabId(cmd.tabId);
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({
            html: document.documentElement.outerHTML.slice(0, 500_000),
            url: location.href,
            title: document.title,
          }),
        });
        return r?.result || { error: "no result" };
      }
      case "querySelector": {
        const tabId = await resolveTabId(cmd.tabId);
        const limit = cmd.limit || 20;
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          args: [cmd.selector, limit],
          func: (selector, limit) => {
            const els = Array.from(document.querySelectorAll(selector)).slice(0, limit);
            return {
              count: els.length,
              elements: els.map((el) => {
                const rect = el.getBoundingClientRect();
                return {
                  tag: el.tagName.toLowerCase(),
                  text: (el.innerText || el.textContent || "").trim().slice(0, 500),
                  attrs: {
                    id: el.id || undefined,
                    class: el.className || undefined,
                    href: el.href || undefined,
                    value: el.value || undefined,
                    type: el.type || undefined,
                    name: el.name || undefined,
                    placeholder: el.placeholder || undefined,
                  },
                  visible: rect.width > 0 && rect.height > 0,
                  rect: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    w: Math.round(rect.width),
                    h: Math.round(rect.height),
                  },
                };
              }),
            };
          },
        });
        return r?.result || { error: "no result" };
      }

      // --- Tabs: navigation ---
      case "navigate": {
        const tabId = await resolveTabId(cmd.tabId);
        const t = await chrome.tabs.update(tabId, { url: cmd.url });
        return { id: t.id, url: t.url, status: t.status };
      }
      case "openTab": {
        const t = await chrome.tabs.create({
          url: cmd.url,
          active: cmd.active !== false,
        });
        return { id: t.id, url: t.url, windowId: t.windowId };
      }
      case "focusTab": {
        await chrome.tabs.update(cmd.tabId, { active: true });
        const t = await chrome.tabs.get(cmd.tabId);
        await chrome.windows.update(t.windowId, { focused: true });
        return { id: t.id, url: t.url, windowId: t.windowId };
      }
      case "closeTab":
        await chrome.tabs.remove(cmd.tabId);
        return { success: true, closedId: cmd.tabId };

      // --- DOM: actions ---
      case "clickElement": {
        const tabId = await resolveTabId(cmd.tabId);
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          args: [cmd.selector],
          func: (selector) => {
            const el = document.querySelector(selector);
            if (!el) return { success: false, error: `No match for selector: ${selector}` };
            try {
              el.scrollIntoView({ block: "center", behavior: "instant" });
              el.click();
              return { success: true, tag: el.tagName.toLowerCase(), text: (el.innerText || "").slice(0, 100) };
            } catch (e) {
              return { success: false, error: e.message };
            }
          },
        });
        return r?.result || { error: "no result" };
      }
      case "fillInput": {
        const tabId = await resolveTabId(cmd.tabId);
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          args: [cmd.selector, cmd.value],
          func: (selector, value) => {
            const el = document.querySelector(selector);
            if (!el) return { success: false, error: `No match for selector: ${selector}` };
            try {
              el.focus();
              const protoMap = {
                TEXTAREA: HTMLTextAreaElement.prototype,
                SELECT: HTMLSelectElement.prototype,
                INPUT: HTMLInputElement.prototype,
              };
              const proto = protoMap[el.tagName];
              const setter = proto
                ? Object.getOwnPropertyDescriptor(proto, "value")?.set
                : null;
              if (setter) setter.call(el, value);
              else el.value = value;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return { success: true, tag: el.tagName.toLowerCase(), value: el.value };
            } catch (e) {
              return { success: false, error: e.message };
            }
          },
        });
        return r?.result || { error: "no result" };
      }
      case "getFormSchema": {
        const tabId = await resolveTabId(cmd.tabId);
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          args: [cmd.formSelector || null],
          func: (formSelector) => {
            function resolveLabel(el) {
              if (el.id) {
                const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (lbl) return lbl.textContent.trim();
              }
              const aria = el.getAttribute("aria-label");
              if (aria) return aria.trim();
              const labelledBy = el.getAttribute("aria-labelledby");
              if (labelledBy) {
                const lbl = document.getElementById(labelledBy);
                if (lbl) return lbl.textContent.trim();
              }
              const parent = el.closest("label");
              if (parent) {
                const clone = parent.cloneNode(true);
                clone.querySelectorAll("input, select, textarea").forEach((x) => x.remove());
                return clone.textContent.trim();
              }
              // previous-sibling text heuristic (3 levels up)
              let sib = el.previousElementSibling;
              for (let i = 0; i < 3 && sib; i++, sib = sib.previousElementSibling) {
                const txt = sib.textContent.trim();
                if (txt && txt.length < 100) return txt;
              }
              return null;
            }
            function uniqueSelector(el) {
              if (el.id) return `#${CSS.escape(el.id)}`;
              if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
              return null;
            }
            const root = formSelector
              ? document.querySelector(formSelector)
              : document.querySelector("form") || document.body;
            if (!root) return { error: `No element for selector: ${formSelector}` };
            const fields = Array.from(root.querySelectorAll("input, select, textarea"))
              .filter((el) => {
                if (el.type === "hidden") return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
              })
              .map((el) => {
                const field = {
                  selector: uniqueSelector(el),
                  label: resolveLabel(el),
                  tag: el.tagName.toLowerCase(),
                  type: el.type || el.tagName.toLowerCase(),
                  name: el.name || null,
                  required: !!(el.required || el.getAttribute("aria-required") === "true"),
                  value: el.value || "",
                };
                const cls = typeof el.className === "string" ? el.className : "";
                if (cls.includes("multiselect")) {
                  field.custom = "multiselect";
                  field.note = "Custom widget — use click-flow, not fill_form";
                }
                if (el.tagName === "SELECT") {
                  field.options = Array.from(el.options).map((o) => ({
                    value: o.value,
                    text: o.text.trim(),
                  }));
                }
                return field;
              });
            return {
              formSelector: formSelector || "form",
              url: location.href,
              fieldCount: fields.length,
              fields,
            };
          },
        });
        return r?.result || { error: "no result" };
      }
      case "fillForm": {
        const tabId = await resolveTabId(cmd.tabId);
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          args: [cmd.fields || []],
          func: (fields) => {
            const protoMap = {
              TEXTAREA: HTMLTextAreaElement.prototype,
              SELECT: HTMLSelectElement.prototype,
              INPUT: HTMLInputElement.prototype,
            };
            const results = [];
            for (const f of fields) {
              try {
                const el = document.querySelector(f.selector);
                if (!el) {
                  results.push({ selector: f.selector, success: false, error: "not found" });
                  continue;
                }
                el.focus();
                if (el.type === "checkbox" || el.type === "radio") {
                  const want =
                    f.value === true || f.value === "true" || f.value === "on" || f.value === 1;
                  if (el.checked !== want) el.click();
                  results.push({ selector: f.selector, success: true, checked: el.checked });
                  continue;
                }
                const proto = protoMap[el.tagName];
                const setter = proto
                  ? Object.getOwnPropertyDescriptor(proto, "value")?.set
                  : null;
                const v = String(f.value);
                if (setter) setter.call(el, v);
                else el.value = v;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                results.push({ selector: f.selector, success: true, value: el.value });
              } catch (e) {
                results.push({ selector: f.selector, success: false, error: e.message });
              }
            }
            return {
              total: fields.length,
              successful: results.filter((r) => r.success).length,
              results,
            };
          },
        });
        return r?.result || { error: "no result" };
      }
      case "waitForSelector": {
        const tabId = await resolveTabId(cmd.tabId);
        const [r] = await chrome.scripting.executeScript({
          target: { tabId },
          args: [cmd.selector, cmd.timeoutMs || 5000],
          func: async (selector, timeoutMs) => {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
              const el = document.querySelector(selector);
              if (el) {
                const rect = el.getBoundingClientRect();
                return {
                  success: true,
                  elapsedMs: Date.now() - start,
                  visible: rect.width > 0 && rect.height > 0,
                };
              }
              await new Promise((r) => setTimeout(r, 100));
            }
            return { success: false, timeout: true, elapsedMs: timeoutMs };
          },
        });
        return r?.result || { error: "no result" };
      }

      default:
        return { error: `Unknown action: ${cmd.action}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// --- Helpers for tab/DOM commands ---

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function resolveTabId(maybeTabId) {
  if (maybeTabId) return maybeTabId;
  const t = await getActiveTab();
  if (!t) throw new Error("No active tab");
  return t.id;
}

// Send a message to the content script, auto-injecting if not loaded.
function sendContentMessage(tabId, message) {
  return new Promise((resolve) => {
    const tryOnce = (withRetry) => {
      chrome.tabs.sendMessage(tabId, message, (res) => {
        const err = chrome.runtime.lastError;
        if (!err && res) return resolve(res);
        if (!withRetry) return resolve({ error: err?.message || "No response from content script" });
        chrome.scripting.executeScript(
          { target: { tabId }, files: ["content.js"] },
          () => {
            const injErr = chrome.runtime.lastError;
            if (injErr) return resolve({ error: `inject failed: ${injErr.message} (chrome://, store, or PDF page?)` });
            setTimeout(() => tryOnce(false), 300);
          }
        );
      });
    };
    tryOnce(true);
  });
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

  if (msg.type === "reconnect-bookmarks-mcp") {
    // Force-reset polling flag and kick off a fresh long-poll cycle.
    bookmarksPolling = false;
    bookmarksLongPoll();
    sendResponse({ ok: true });
    return;
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

// Notify sidebar when the active tab's URL changes (includes YouTube SPA navigation).
// Without this, sidebar's YT offer keeps stale videoId and cached transcript is "wrong".
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0] || tabs[0].id !== tabId) return;
    try {
      chrome.runtime.sendMessage(
        { type: "tab-url-changed", url: changeInfo.url, title: tab.title || "" },
        () => { void chrome.runtime.lastError; /* sidebar not open = OK */ }
      );
    } catch {}
  });
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
