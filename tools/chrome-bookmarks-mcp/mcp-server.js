import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import http from "http";
import fs from "fs";
import path from "path";
import { z } from "zod";

// --- Config ---
const PORT = Number(process.env.CHROME_BRIDGE_PORT) || 3777;
const BOOKMARKS_PATH =
  "/mnt/c/Users/oposp/AppData/Local/Google/Chrome/User Data/Default/Bookmarks";
const EXTENSION_TIMEOUT = 30_000;

// --- Extension bridge (long-poll HTTP) ---
let pendingCommand = null;
let resolveCommand = null;
const waitingClients = new Set();

function sendToExtension(command) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommand = null;
      resolveCommand = null;
      reject(
        new Error(
          "Extension timeout — is Chrome running with the extension loaded?"
        )
      );
    }, EXTENSION_TIMEOUT);

    pendingCommand = command;
    resolveCommand = (result) => {
      clearTimeout(timer);
      pendingCommand = null;
      resolveCommand = null;
      resolve(result);
    };

    // Notify any long-polling clients
    for (const client of waitingClients) {
      clearTimeout(client.timeout);
      client.res.writeHead(200, { "Content-Type": "application/json" });
      client.res.end(JSON.stringify(command));
      waitingClients.delete(client);
    }
  });
}

const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Long-poll: extension asks for next command
  if (req.method === "GET" && req.url === "/poll") {
    if (pendingCommand) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(pendingCommand));
    }
    // Hold connection until command arrives or 25s timeout
    const timeout = setTimeout(() => {
      waitingClients.delete(client);
      res.writeHead(204);
      res.end();
    }, 25_000);
    const client = { res, timeout };
    waitingClients.add(client);
    req.on("close", () => {
      clearTimeout(timeout);
      waitingClients.delete(client);
    });
    return;
  }

  // Extension posts result
  if (req.method === "POST" && req.url === "/result") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const result = JSON.parse(body);
        if (resolveCommand) resolveCommand(result);
      } catch (e) {
        if (resolveCommand) resolveCommand({ error: "Invalid JSON from extension" });
      }
      res.writeHead(200);
      res.end("ok");
    });
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "running",
        extensionConnected: waitingClients.size > 0,
        hasPending: !!pendingCommand,
      })
    );
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  process.stderr.write(`HTTP bridge listening on http://localhost:${PORT}\n`);
});

// --- Direct file reads (instant, no extension needed) ---
function readBookmarksFile() {
  const raw = fs.readFileSync(BOOKMARKS_PATH, "utf-8");
  return JSON.parse(raw);
}

function flattenBookmarks(node, parentPath = "") {
  const results = [];
  const currentPath = parentPath
    ? `${parentPath}/${node.name || ""}`
    : node.name || "";

  if (node.type === "url") {
    results.push({
      id: node.id,
      title: node.name,
      url: node.url,
      path: parentPath,
      dateAdded: node.date_added,
    });
  }

  if (node.children) {
    for (const child of node.children) {
      results.push(...flattenBookmarks(child, currentPath));
    }
  }
  return results;
}

function getTree(folderId) {
  const data = readBookmarksFile();

  if (!folderId) {
    // Return top-level structure summary
    const bar = data.roots.bookmark_bar;
    return summarizeFolder(bar);
  }

  // Find specific folder
  const node = findNodeById(data.roots, folderId);
  if (!node) return { error: `Folder ${folderId} not found` };
  return summarizeFolder(node);
}

function summarizeFolder(node) {
  const result = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.children) {
    result.children = node.children.map((child) => {
      if (child.type === "folder") {
        const urlCount = countUrls(child);
        return {
          id: child.id,
          name: child.name,
          type: "folder",
          urlCount,
        };
      }
      return {
        id: child.id,
        title: child.name,
        url: child.url,
        type: "url",
      };
    });
  }
  return result;
}

function countUrls(node) {
  let count = 0;
  if (node.type === "url") return 1;
  for (const child of node.children || []) {
    count += countUrls(child);
  }
  return count;
}

function findNodeById(node, id) {
  if (node.id === id) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeById(child, id);
      if (found) return found;
    }
  }
  // Check roots
  if (node.bookmark_bar) {
    for (const root of Object.values(node)) {
      if (typeof root === "object" && root !== null) {
        const found = findNodeById(root, id);
        if (found) return found;
      }
    }
  }
  return null;
}

function searchBookmarks(query) {
  const data = readBookmarksFile();
  const all = [];
  for (const root of Object.values(data.roots)) {
    if (typeof root === "object" && root !== null) {
      all.push(...flattenBookmarks(root));
    }
  }
  const q = query.toLowerCase();
  return all.filter(
    (b) =>
      b.title?.toLowerCase().includes(q) || b.url?.toLowerCase().includes(q)
  );
}

function findDuplicates() {
  const data = readBookmarksFile();
  const all = [];
  for (const root of Object.values(data.roots)) {
    if (typeof root === "object" && root !== null) {
      all.push(...flattenBookmarks(root));
    }
  }

  const urlMap = {};
  for (const bm of all) {
    if (!bm.url) continue;
    const normalized = bm.url.replace(/\/+$/, "").replace(/^https?:\/\//, "");
    if (!urlMap[normalized]) urlMap[normalized] = [];
    urlMap[normalized].push({ id: bm.id, title: bm.title, path: bm.path });
  }

  const duplicates = {};
  for (const [url, items] of Object.entries(urlMap)) {
    if (items.length > 1) duplicates[url] = items;
  }
  return { total: Object.keys(duplicates).length, duplicates };
}

// --- MCP Server ---
const server = new McpServer({
  name: "chrome-bookmarks",
  version: "1.0.0",
});

// Read tools (direct file access — instant)

server.tool(
  "list_bookmarks",
  "List bookmarks in a folder. Without folderId lists the bookmark bar top-level.",
  { folderId: z.string().optional().describe("Folder ID (omit for bookmark bar)") },
  async ({ folderId }) => {
    const result = getTree(folderId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "search_bookmarks",
  "Search bookmarks by title or URL substring",
  { query: z.string().describe("Search query") },
  async ({ query }) => {
    const results = searchBookmarks(query);
    return {
      content: [
        {
          type: "text",
          text: `Found ${results.length} results:\n${JSON.stringify(results, null, 2)}`,
        },
      ],
    };
  }
);

server.tool(
  "find_duplicates",
  "Find bookmarks with duplicate URLs",
  {},
  async () => {
    const result = findDuplicates();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Write tools (via extension bridge)

server.tool(
  "move_bookmark",
  "Move a bookmark or folder to a different parent folder",
  {
    bookmarkId: z.string().describe("ID of bookmark to move"),
    parentId: z.string().describe("ID of destination folder"),
    index: z.number().optional().describe("Position within folder"),
  },
  async ({ bookmarkId, parentId, index }) => {
    const result = await sendToExtension({
      action: "move",
      bookmarkId,
      parentId,
      index,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "create_bookmark",
  "Create a new bookmark (URL)",
  {
    title: z.string().describe("Bookmark title (empty string for icon-only)"),
    url: z.string().describe("Bookmark URL"),
    parentId: z
      .string()
      .optional()
      .describe("Parent folder ID (default: bookmark bar = '1')"),
  },
  async ({ title, url, parentId }) => {
    const result = await sendToExtension({
      action: "createBookmark",
      title,
      url,
      parentId: parentId || "1",
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "create_folder",
  "Create a new bookmark folder",
  {
    title: z.string().describe("Folder name"),
    parentId: z
      .string()
      .optional()
      .describe("Parent folder ID (default: bookmark bar = '1')"),
  },
  async ({ title, parentId }) => {
    const result = await sendToExtension({
      action: "createFolder",
      title,
      parentId: parentId || "1",
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "delete_bookmark",
  "Delete a bookmark or empty folder",
  { bookmarkId: z.string().describe("ID of bookmark to delete") },
  async ({ bookmarkId }) => {
    const result = await sendToExtension({
      action: "delete",
      bookmarkId,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "update_bookmark",
  "Update a bookmark's title or URL",
  {
    bookmarkId: z.string().describe("ID of bookmark to update"),
    title: z.string().optional().describe("New title"),
    url: z.string().optional().describe("New URL"),
  },
  async ({ bookmarkId, title, url }) => {
    const changes = {};
    if (title) changes.title = title;
    if (url) changes.url = url;
    const result = await sendToExtension({
      action: "update",
      bookmarkId,
      ...changes,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Tabs: inspection ---

server.tool(
  "list_tabs",
  "List all open Chrome tabs across all windows (id, url, title, active, windowId, favicon)",
  {},
  async () => {
    const result = await sendToExtension({ action: "listTabs" });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "get_active_tab",
  "Get the currently active tab in the focused window (shortcut for filtering list_tabs)",
  {},
  async () => {
    const result = await sendToExtension({ action: "getActiveTab" });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "screenshot_active_tab",
  "Capture viewport-only PNG screenshot of the active tab. Returns as image content (I see it directly).",
  {},
  async () => {
    const result = await sendToExtension({ action: "screenshotActive" });
    if (result.error) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    }
    return {
      content: [
        {
          type: "text",
          text: `Screenshot of tab ${result.tabId}: ${result.title}\n${result.url}`,
        },
        { type: "image", data: result.dataBase64, mimeType: "image/png" },
      ],
    };
  }
);

// --- DOM: read ---

server.tool(
  "read_page_text",
  "Extract readable text from a tab's page. Uses the existing Pekacek content script (handles YouTube, article cleanup). Default: active tab.",
  { tabId: z.number().optional().describe("Tab ID (default: active tab)") },
  async ({ tabId }) => {
    const result = await sendToExtension({ action: "readPageText", tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "read_page_html",
  "Get raw outerHTML of a tab's page (capped at 500KB). Default: active tab.",
  { tabId: z.number().optional() },
  async ({ tabId }) => {
    const result = await sendToExtension({ action: "readPageHtml", tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "query_selector",
  "Query elements matching a CSS selector. Returns tag/text/attrs/rect/visibility for up to `limit` elements. Useful for debugging selectors before clicking.",
  {
    selector: z.string().describe("CSS selector"),
    tabId: z.number().optional(),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ selector, tabId, limit }) => {
    const result = await sendToExtension({
      action: "querySelector",
      selector,
      tabId,
      limit: limit || 20,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- Tabs: navigation ---

server.tool(
  "navigate_tab",
  "Navigate an existing tab to a new URL. Default: active tab.",
  {
    url: z.string().describe("Target URL"),
    tabId: z.number().optional(),
  },
  async ({ url, tabId }) => {
    const result = await sendToExtension({ action: "navigate", url, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "open_tab",
  "Open a new tab with given URL",
  {
    url: z.string().describe("URL to open"),
    active: z.boolean().optional().describe("Focus the new tab (default true)"),
  },
  async ({ url, active }) => {
    const result = await sendToExtension({
      action: "openTab",
      url,
      active: active !== false,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "focus_tab",
  "Make a tab active and bring its window to the foreground",
  { tabId: z.number().describe("Tab ID") },
  async ({ tabId }) => {
    const result = await sendToExtension({ action: "focusTab", tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "close_tab",
  "Close a tab",
  { tabId: z.number().describe("Tab ID") },
  async ({ tabId }) => {
    const result = await sendToExtension({ action: "closeTab", tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- DOM: actions ---

server.tool(
  "click_element",
  "Click an element matching a CSS selector. Scrolls into view first. Fails if no match or if page CSP blocks script injection.",
  {
    selector: z.string().describe("CSS selector"),
    tabId: z.number().optional(),
  },
  async ({ selector, tabId }) => {
    const result = await sendToExtension({ action: "clickElement", selector, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "fill_input",
  "Fill a text input/textarea with a value. Uses native setter + dispatches input/change events so React/Vue controlled inputs register the update.",
  {
    selector: z.string().describe("CSS selector for the input"),
    value: z.string().describe("Value to set"),
    tabId: z.number().optional(),
  },
  async ({ selector, value, tabId }) => {
    const result = await sendToExtension({
      action: "fillInput",
      selector,
      value,
      tabId,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "get_form_schema",
  "Extract structured schema for all visible form fields in a page: label (resolved from <label for>, aria-label, aria-labelledby, parent label, or nearby text), type, selector, value, required, options (for selects). Prefer this over screenshot+query_selector when the goal is filling a form — one call gives everything needed.",
  {
    formSelector: z.string().optional().describe("CSS selector for form (default: first <form>)"),
    tabId: z.number().optional(),
  },
  async ({ formSelector, tabId }) => {
    const result = await sendToExtension({
      action: "getFormSchema",
      formSelector,
      tabId,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "fill_form",
  "Fill multiple form fields in one roundtrip (10× faster than fill_input per field). Handles input/textarea/select via native setter + input/change events (React/Vue safe). Checkbox/radio via click. Returns per-field {selector, success, value|error}. Use get_form_schema first to discover selectors & labels.",
  {
    fields: z
      .array(
        z.object({
          selector: z.string().describe("CSS selector for the field"),
          value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to set"),
        })
      )
      .describe("Array of fields to fill"),
    tabId: z.number().optional(),
  },
  async ({ fields, tabId }) => {
    const result = await sendToExtension({ action: "fillForm", fields, tabId });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "wait_for_selector",
  "Poll a tab until a CSS selector matches an element or timeout expires. Returns elapsed time on success.",
  {
    selector: z.string().describe("CSS selector"),
    timeoutMs: z.number().optional().describe("Max wait in ms (default 5000)"),
    tabId: z.number().optional(),
  },
  async ({ selector, timeoutMs, tabId }) => {
    const result = await sendToExtension({
      action: "waitForSelector",
      selector,
      timeoutMs: timeoutMs || 5000,
      tabId,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Start MCP
const transport = new StdioServerTransport();
await server.connect(transport);
