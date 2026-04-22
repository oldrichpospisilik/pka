import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import http from "http";
import fs from "fs";
import path from "path";
import { z } from "zod";

// --- Config ---
const PORT = 3777;
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

// Start MCP
const transport = new StdioServerTransport();
await server.connect(transport);
