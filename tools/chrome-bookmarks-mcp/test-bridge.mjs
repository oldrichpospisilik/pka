// End-to-end test of the MCP ↔ HTTP bridge ↔ (mock extension) chain.
//
// Boots mcp-server.js on a dedicated test port, connects as an MCP client via
// stdio, and simultaneously runs a fake extension that long-polls the bridge
// and replies with mock data for each action. Verifies that every tool
// round-trips correctly and returns the shape its MCP handler expects.
//
// Run:  node test-bridge.mjs
// Exit 0 = all tests passed, non-zero = failure.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3787;  // dedicated test port
const BASE = `http://localhost:${PORT}`;

let pass = 0;
let fail = 0;
const failures = [];

function log(label, ok, detail = "") {
  const mark = ok ? "✓" : "✗";
  const color = ok ? "\x1b[32m" : "\x1b[31m";
  console.log(`  ${color}${mark}\x1b[0m ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else {
    fail++;
    failures.push(label);
  }
}

// Mock extension handlers — return canned responses per action.
const mockHandlers = {
  // bookmarks (pre-existing, sanity check)
  createBookmark: (c) => ({ id: "999", title: c.title, url: c.url, parentId: c.parentId }),
  createFolder: (c) => ({ id: "998", title: c.title, parentId: c.parentId }),
  move: (c) => ({ id: c.bookmarkId, parentId: c.parentId, index: c.index ?? 0 }),
  delete: (c) => ({ success: true, deletedId: c.bookmarkId }),
  update: (c) => ({ id: c.bookmarkId, title: c.title, url: c.url }),

  // tabs: inspection
  listTabs: () => ({
    tabs: [
      { id: 1, windowId: 10, url: "https://example.com", title: "Example", active: true, pinned: false, favIconUrl: "" },
      { id: 2, windowId: 10, url: "https://news.ycombinator.com", title: "HN", active: false, pinned: false, favIconUrl: "" },
    ],
  }),
  getActiveTab: () => ({ id: 1, windowId: 10, url: "https://example.com", title: "Example" }),
  screenshotActive: () => ({
    // tiny valid PNG (1x1 transparent)
    dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
    tabId: 1,
    url: "https://example.com",
    title: "Example",
  }),

  // DOM read
  readPageText: (c) => ({ title: "Example", url: "https://example.com", text: "Hello world", length: 11, tabIdEcho: c.tabId }),
  readPageHtml: () => ({ html: "<html><body>hi</body></html>", url: "https://example.com", title: "Example" }),
  querySelector: (c) => ({
    count: 2,
    elements: [
      { tag: "a", text: "Click me", attrs: { href: "https://foo" }, visible: true, rect: { x: 10, y: 20, w: 100, h: 30 } },
      { tag: "a", text: "Other", attrs: { href: "https://bar" }, visible: true, rect: { x: 10, y: 60, w: 100, h: 30 } },
    ],
    selectorEcho: c.selector,
  }),

  // tabs: navigation
  navigate: (c) => ({ id: c.tabId || 1, url: c.url, status: "loading" }),
  openTab: (c) => ({ id: 42, url: c.url, windowId: 10 }),
  focusTab: (c) => ({ id: c.tabId, url: "https://example.com", windowId: 10 }),
  closeTab: (c) => ({ success: true, closedId: c.tabId }),

  // DOM actions
  clickElement: (c) => ({ success: true, tag: "button", text: "Submit", selectorEcho: c.selector }),
  fillInput: (c) => ({ success: true, tag: "input", value: c.value, selectorEcho: c.selector }),
  waitForSelector: (c) => ({ success: true, elapsedMs: 234, visible: true, selectorEcho: c.selector }),

  // Form bulk ops
  getFormSchema: (c) => ({
    formSelector: c.formSelector || "form",
    url: "https://example.com/form",
    fieldCount: 3,
    fields: [
      { selector: "#name", label: "Name", tag: "input", type: "text", name: "name", required: true, value: "" },
      { selector: "#email", label: "Email", tag: "input", type: "email", name: "email", required: true, value: "" },
      {
        selector: "#country",
        label: "Country",
        tag: "select",
        type: "select-one",
        name: "country",
        required: false,
        value: "",
        options: [{ value: "cz", text: "Česko" }, { value: "sk", text: "Slovensko" }],
      },
    ],
  }),
  fillForm: (c) => ({
    total: c.fields.length,
    successful: c.fields.length,
    results: c.fields.map((f) => ({ selector: f.selector, success: true, value: String(f.value) })),
  }),
};

// --- Fake extension: long-poll loop ---
let extRunning = true;
async function fakeExtension() {
  while (extRunning) {
    try {
      const res = await fetch(`${BASE}/poll`);
      if (res.status === 200) {
        const cmd = await res.json();
        const handler = mockHandlers[cmd.action];
        const result = handler ? handler(cmd) : { error: `no mock for ${cmd.action}` };
        await fetch(`${BASE}/result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(result),
        });
      }
      // 204 = poll timeout, just reloop
    } catch {
      if (extRunning) await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// --- Boot MCP client (which spawns the server) ---
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(__dirname, "mcp-server.js")],
  env: { ...process.env, CHROME_BRIDGE_PORT: String(PORT) },
});

const client = new Client({ name: "test-harness", version: "1.0.0" });

console.log("\n→ Booting MCP server on port " + PORT + "...");
await client.connect(transport);
console.log("→ Connected. Waiting 300ms for HTTP bridge to bind...");
await new Promise((r) => setTimeout(r, 300));

// Start fake extension AFTER server is up
fakeExtension();

// Helper: call a tool and parse first content text block
async function callTool(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const textBlock = res.content.find((c) => c.type === "text");
  const imgBlock = res.content.find((c) => c.type === "image");
  return {
    text: textBlock?.text,
    parsed: textBlock ? safeParse(textBlock.text) : null,
    image: imgBlock,
    raw: res,
  };
}
function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

console.log("\n━━━ MCP tool round-trip tests ━━━\n");

// 1. List tools — ensure new ones registered
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
const expected = [
  "list_bookmarks", "search_bookmarks", "find_duplicates",
  "create_bookmark", "create_folder", "move_bookmark", "delete_bookmark", "update_bookmark",
  "list_tabs", "get_active_tab", "screenshot_active_tab",
  "read_page_text", "read_page_html", "query_selector",
  "navigate_tab", "open_tab", "focus_tab", "close_tab",
  "click_element", "fill_input", "wait_for_selector",
  "get_form_schema", "fill_form",
];
const missing = expected.filter((n) => !names.includes(n));
log(`Registered tools: ${names.length}`, missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : `all ${expected.length} expected present`);

// 2. list_tabs
{
  const r = await callTool("list_tabs");
  const ok = r.parsed?.tabs?.length === 2 && r.parsed.tabs[0].url === "https://example.com";
  log("list_tabs", ok, ok ? `returned ${r.parsed.tabs.length} tabs` : JSON.stringify(r.parsed));
}

// 3. get_active_tab
{
  const r = await callTool("get_active_tab");
  const ok = r.parsed?.id === 1 && r.parsed?.url === "https://example.com";
  log("get_active_tab", ok);
}

// 4. screenshot_active_tab — must return image content block
{
  const r = await callTool("screenshot_active_tab");
  const ok = r.image && r.image.mimeType === "image/png" && typeof r.image.data === "string" && r.image.data.length > 20;
  log("screenshot_active_tab", ok, ok ? `image ${r.image.data.length} chars base64` : "no image block");
}

// 5. read_page_text (with tabId argument)
{
  const r = await callTool("read_page_text", { tabId: 7 });
  const ok = r.parsed?.text === "Hello world" && r.parsed?.tabIdEcho === 7;
  log("read_page_text (tabId passthrough)", ok);
}

// 6. read_page_html
{
  const r = await callTool("read_page_html");
  const ok = r.parsed?.html?.includes("<body>hi</body>");
  log("read_page_html", ok);
}

// 7. query_selector
{
  const r = await callTool("query_selector", { selector: "a.link", limit: 5 });
  const ok = r.parsed?.count === 2 && r.parsed?.selectorEcho === "a.link";
  log("query_selector (echoes selector)", ok);
}

// 8. navigate_tab
{
  const r = await callTool("navigate_tab", { url: "https://new.example" });
  const ok = r.parsed?.url === "https://new.example";
  log("navigate_tab", ok);
}

// 9. open_tab
{
  const r = await callTool("open_tab", { url: "https://newtab.example", active: false });
  const ok = r.parsed?.url === "https://newtab.example" && r.parsed?.id === 42;
  log("open_tab", ok);
}

// 10. focus_tab
{
  const r = await callTool("focus_tab", { tabId: 7 });
  const ok = r.parsed?.id === 7;
  log("focus_tab", ok);
}

// 11. close_tab
{
  const r = await callTool("close_tab", { tabId: 7 });
  const ok = r.parsed?.success === true && r.parsed?.closedId === 7;
  log("close_tab", ok);
}

// 12. click_element
{
  const r = await callTool("click_element", { selector: "button#submit" });
  const ok = r.parsed?.success === true && r.parsed?.selectorEcho === "button#submit";
  log("click_element (echoes selector)", ok);
}

// 13. fill_input
{
  const r = await callTool("fill_input", { selector: "input[name=q]", value: "hello world" });
  const ok = r.parsed?.success === true && r.parsed?.value === "hello world";
  log("fill_input (value passthrough)", ok);
}

// 14. wait_for_selector
{
  const r = await callTool("wait_for_selector", { selector: ".loaded", timeoutMs: 3000 });
  const ok = r.parsed?.success === true && typeof r.parsed?.elapsedMs === "number";
  log("wait_for_selector", ok);
}

// 14b. get_form_schema
{
  const r = await callTool("get_form_schema", {});
  const ok =
    r.parsed?.fieldCount === 3 &&
    r.parsed?.fields?.[0]?.label === "Name" &&
    r.parsed?.fields?.[2]?.options?.length === 2;
  log("get_form_schema (labels + options)", ok);
}

// 14c. fill_form
{
  const r = await callTool("fill_form", {
    fields: [
      { selector: "#a", value: "foo" },
      { selector: "#b", value: 42 },
      { selector: "#c", value: true },
    ],
  });
  const ok =
    r.parsed?.total === 3 &&
    r.parsed?.successful === 3 &&
    r.parsed?.results?.length === 3;
  log("fill_form (batch of 3)", ok, ok ? `all 3 filled` : JSON.stringify(r.parsed));
}

// 15. Sanity: pre-existing bookmark tool still works
{
  const r = await callTool("create_bookmark", { title: "T", url: "https://t.example" });
  const ok = r.parsed?.title === "T" && r.parsed?.url === "https://t.example";
  log("(regression) create_bookmark still works", ok);
}

// 16. Unknown action returns error gracefully (would surface if we accidentally
//     added an MCP tool but forgot the background.js handler).
//     Simulated here by handler returning error shape.
// (We can't easily trigger this without a real "orphan" tool; skip.)

extRunning = false;
await client.close();

console.log(`\n━━━ ${pass}/${pass + fail} passed ━━━`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
