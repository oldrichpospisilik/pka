// Pekacek Sidebar v2.0 — Reading Companion
// Komunikuje s Claude Code pres lokalni bridge (WSL)

// --- Pekacek Faces ---
const FACES = {
  idle:       "  ( o_o)\n  /|___|\\",
  wave:       "  ( o_o)/\n  /|___| ",
  coffee:     "  ( o_o) ☕\n  /|___|\\",
  happy:      "\\(^o^)/",
  thinking:   "(￣ー￣) ...",
  curious:    "(☞ﾟヮﾟ)☞",
  excited:    "(＾▽＾)",
  worried:    "(>_<)",
  chill:      "ʕ•ᴥ•ʔ",
  proud:      "\\(^o^)/",
  reading:    "  [📚]\n (•‿•)\n /|_|\\",
  dancing:    "  ♪┌(˘⌣˘)ʃ♪\n    /|_|\\\n   _/   \\_",
  determined: "(ง •̀_•́)ง",
  surprised:  "(°ロ°) !",
};

// --- Bridge ---
const BRIDGE_URL = "http://localhost:3888";

// --- State ---
let currentPageContent = null;
let articleRead = false;   // true after Pekáček read the article into session
let lastReadUrl = null;    // URL of the article in session
let currentStreamId = null; // reqId of in-flight /ask request (for Stop)
let currentAbortCtrl = null; // AbortController pro aktuální stream

// --- Session persistence (chrome.storage.local) ---
const SESSIONS_KEY = "pekacek.sessions";
const CURRENT_SESSION_KEY = "pekacek.currentSessionId";
const MAX_SESSIONS = 30;
let currentSession = null;           // { id, title, url, createdAt, updatedAt, messages, articleRead, claudeSessionId }
let isRestoringSession = false;      // when true, addMessage skips persistence

function makeSessionId() {
  return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function startNewSession() {
  currentSession = {
    id: makeSessionId(),
    title: "Nová konverzace",
    url: null,
    urlTitle: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    articleRead: false,
    claudeSessionId: null,
  };
  try { chrome.storage.local.set({ [CURRENT_SESSION_KEY]: currentSession.id }); } catch {}
}

async function listSessions() {
  try {
    const r = await chrome.storage.local.get(SESSIONS_KEY);
    return r[SESSIONS_KEY] || [];
  } catch { return []; }
}

async function saveSessions(sessions) {
  try { await chrome.storage.local.set({ [SESSIONS_KEY]: sessions }); } catch {}
}

async function persistCurrentSession() {
  if (!currentSession || currentSession.messages.length === 0) return;
  currentSession.updatedAt = Date.now();
  currentSession.articleRead = articleRead;
  if (!currentSession.url && currentPageContent?.url) {
    currentSession.url = currentPageContent.url;
    currentSession.urlTitle = currentPageContent.title || null;
  }
  const sessions = await listSessions();
  const idx = sessions.findIndex((s) => s.id === currentSession.id);
  if (idx >= 0) sessions[idx] = currentSession;
  else sessions.unshift(currentSession);
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  while (sessions.length > MAX_SESSIONS) sessions.pop();
  await saveSessions(sessions);
}

function recordMessage(role, rawText) {
  if (isRestoringSession) return;
  if (!currentSession) startNewSession();
  currentSession.messages.push({ role, rawText, at: Date.now() });
  if (currentSession.title === "Nová konverzace" && role === "user" && rawText?.trim()) {
    currentSession.title = rawText.trim().slice(0, 80);
  }
  persistCurrentSession();
}

async function deleteSessionFromStorage(id) {
  const sessions = await listSessions();
  await saveSessions(sessions.filter((s) => s.id !== id));
  if (currentSession?.id === id) {
    startNewSession();
    messagesEl.innerHTML = "";
    messageCounter = 0;
  }
}

async function restoreSessionFromStorage(id) {
  const sessions = await listSessions();
  const s = sessions.find((x) => x.id === id);
  if (!s) return false;

  isRestoringSession = true;
  try {
    messagesEl.innerHTML = "";
    messageCounter = 0;
    for (const m of s.messages || []) {
      addMessage(m.role, m.rawText || "", false);
    }
    currentSession = s;
    articleRead = !!s.articleRead;
    lastReadUrl = s.url || null;
    try { chrome.storage.local.set({ [CURRENT_SESSION_KEY]: s.id }); } catch {}
    scrollToBottom(true);
    statusText.textContent = `Obnovena: ${truncate(s.title, 30)}`;
    statusText.style.color = "#4ecca3";
    setTimeout(() => {
      statusText.textContent = "Připraveny";
      statusText.style.color = "";
    }, 2500);
    return true;
  } finally {
    isRestoringSession = false;
  }
}

function formatAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return "před chvílí";
  const m = Math.floor(s / 60);
  if (m < 60) return `před ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `před ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `před ${d} dny`;
  return new Date(Date.now() - ms).toLocaleDateString("cs-CZ");
}

async function openHistoryPanel() {
  const panel = document.getElementById("history-panel");
  const list = document.getElementById("history-list");
  panel.classList.remove("hidden");
  list.innerHTML = '<div class="history-empty">Načítám…</div>';

  const sessions = await listSessions();
  if (sessions.length === 0) {
    list.innerHTML = '<div class="history-empty">— žádné uložené konverzace —</div>';
    return;
  }

  list.innerHTML = "";
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "history-item";
    if (s.id === currentSession?.id) item.classList.add("current");

    const titleDiv = document.createElement("div");
    titleDiv.className = "history-item-title";
    titleDiv.textContent = s.title || "(bez názvu)";

    const metaDiv = document.createElement("div");
    metaDiv.className = "history-item-meta";
    const msgCount = s.messages?.length || 0;
    const urlMark = s.url ? " · 🔗" : "";
    metaDiv.textContent = `${formatAgo(Date.now() - s.updatedAt)} · ${msgCount} zpráv${urlMark}`;

    item.appendChild(titleDiv);
    item.appendChild(metaDiv);

    item.addEventListener("click", async () => {
      panel.classList.add("hidden");
      if (s.id !== currentSession?.id) {
        await restoreSessionFromStorage(s.id);
      }
    });

    const delBtn = document.createElement("button");
    delBtn.className = "history-item-del";
    delBtn.textContent = "✕";
    delBtn.title = "Smazat";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Smazat "${truncate(s.title || "(bez názvu)", 40)}"?`)) return;
      await deleteSessionFromStorage(s.id);
      openHistoryPanel(); // refresh
    });
    item.appendChild(delBtn);

    list.appendChild(item);
  }
}

// --- DOM ---
const face = document.getElementById("pekacek-face");
const statusText = document.getElementById("status-text");
const pageIndicator = document.getElementById("page-indicator");
const messagesEl = document.getElementById("messages");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");

// --- Init ---
async function initSession() {
  try {
    const r = await chrome.storage.local.get(CURRENT_SESSION_KEY);
    const id = r[CURRENT_SESSION_KEY];
    if (id) {
      const ok = await restoreSessionFromStorage(id);
      if (!ok) startNewSession();
    } else {
      startNewSession();
    }
  } catch {
    startNewSession();
  }
}

// Non-session things start immediately
loadDashboard();
checkBridgeStatus();
setFace("wave", "animate-wave");
setTimeout(() => {
  setFace("idle", "animate-idle");
  startIdleLife();
}, 2000);

// Clear any pending badge — user is looking at the sidebar now
try { chrome.runtime.sendMessage({ type: "clear-badge" }, () => {}); } catch {}

// Restore session first, then load tab info — otherwise articleRead/lastReadUrl
// from storage aren't applied yet and offer pops up over existing chat.
(async function () {
  await initSession();
  loadTabInfo();
})();

// Reset button — archives current session (auto-persisted) and starts fresh
document.getElementById("reset-btn").addEventListener("click", () => {
  resetChat();
});

// History button — opens overlay with past sessions
document.getElementById("history-btn").addEventListener("click", openHistoryPanel);
document.getElementById("history-close").addEventListener("click", () => {
  document.getElementById("history-panel").classList.add("hidden");
});

// Stop button
stopBtn.addEventListener("click", () => stopStream());

// Esc shortcut — stop generation
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isWorking && currentStreamId) {
    e.preventDefault();
    stopStream();
  }
});

function showStopBtn() {
  stopBtn.style.display = "inline-block";
}

function hideStopBtn() {
  stopBtn.style.display = "none";
}

async function stopStream() {
  if (!currentStreamId) return;
  const id = currentStreamId;
  currentStreamId = null; // prevent double-stop
  try {
    await fetch(`${BRIDGE_URL}/stop?id=${encodeURIComponent(id)}`, { method: "POST" });
  } catch {}
  if (currentAbortCtrl) {
    try { currentAbortCtrl.abort(); } catch {}
  }
}

function resetChat() {
  // Tell bridge to forget cached session for current URL (before clearing state)
  const urlToForget = currentPageContent?.url || lastReadUrl;
  if (urlToForget) {
    fetch(`${BRIDGE_URL}/forget?url=${encodeURIComponent(urlToForget)}`, { method: "POST" })
      .catch(() => {});
  }

  // Archive current session (auto-persisted on each message) and start fresh
  startNewSession();

  // Clear DOM
  messagesEl.innerHTML = "";
  messageCounter = 0;

  // Forget article state
  articleRead = false;
  lastReadUrl = null;
  currentPageContent = null;

  hideNewMessagesButton();
  statusText.textContent = "Připraveny";
  statusText.style.color = "";
  tempFace("chill", "animate-idle", 1500);

  // Re-offer reading after brief delay
  setTimeout(() => loadTabInfo(), 400);
}

// --- Bridge status ---
function checkBridgeStatus() {
  chrome.runtime.sendMessage({ type: "check-bridge" }, (res) => {
    if (res?.status === "running") {
      statusText.textContent = "Claude Code připojen";
      statusText.style.color = "#4ecca3";
    } else {
      statusText.textContent = "Bridge offline";
      statusText.style.color = "#e94560";
      addMessage("pekacek",
        "Bridge není dostupný. Spusť ve WSL:\n\n" +
        "  node tools/pekacek-extension/bridge.mjs\n\n" +
        "Pak mě refreshni (F5 v sidebaru)."
      );
      setFace("worried", "animate-error");
    }
  });
}

// --- Bookmarks MCP status (port 3777) ---
const MCP_URL = "http://localhost:3777";
const mcpStatusEl = document.getElementById("mcp-status");
const mcpDotBtn = document.getElementById("mcp-dot-btn");
const mcpPopover = document.getElementById("mcp-popover");
const mcpStateEl = document.getElementById("mcp-state");
const mcpExtEl = document.getElementById("mcp-ext");
const mcpPendingEl = document.getElementById("mcp-pending");
const mcpReconnectBtn = document.getElementById("mcp-reconnect");

async function checkMcpStatus() {
  try {
    const r = await fetch(`${MCP_URL}/status`, { cache: "no-store" });
    const data = await r.json();
    const running = true;
    const extConnected = !!data.extensionConnected;
    mcpStatusEl.classList.remove("offline");
    mcpStatusEl.classList.toggle("running", running && extConnected);
    mcpStatusEl.classList.toggle("partial", running && !extConnected);
    mcpStateEl.textContent = "běží";
    mcpExtEl.textContent = extConnected ? "připojena" : "čeká na extension";
    mcpPendingEl.textContent = data.hasPending ? "ano" : "ne";
    mcpDotBtn.title = extConnected
      ? "Bookmarks MCP — běží, extension připojena"
      : "Bookmarks MCP — server běží, ale extension nepolluje";
  } catch {
    mcpStatusEl.classList.remove("running", "partial");
    mcpStatusEl.classList.add("offline");
    mcpStateEl.textContent = "offline";
    mcpExtEl.textContent = "—";
    mcpPendingEl.textContent = "—";
    mcpDotBtn.title = "Bookmarks MCP offline — spusť ./start.sh v ~/pka";
  }
}

mcpDotBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = mcpPopover.classList.contains("hidden");
  mcpPopover.classList.toggle("hidden");
  if (willOpen) checkMcpStatus();
});

document.addEventListener("click", (e) => {
  if (!mcpStatusEl.contains(e.target)) mcpPopover.classList.add("hidden");
});

mcpReconnectBtn.addEventListener("click", async () => {
  mcpReconnectBtn.disabled = true;
  const original = mcpReconnectBtn.textContent;
  mcpReconnectBtn.textContent = "↻ Reconnecting…";
  try {
    await chrome.runtime.sendMessage({ type: "reconnect-bookmarks-mcp" });
  } catch {}
  await new Promise((r) => setTimeout(r, 600));
  await checkMcpStatus();
  mcpReconnectBtn.textContent = original;
  mcpReconnectBtn.disabled = false;
});

checkMcpStatus();
setInterval(checkMcpStatus, 5000);

// --- Pekacek Face ---
let idleTimer = null;
let isWorking = false;

function setFace(name, animation = "animate-idle") {
  face.textContent = FACES[name] || FACES.idle;
  face.className = animation;
}

function tempFace(name, animation, durationMs = 2000) {
  isWorking = true;
  stopIdleLife();
  setFace(name, animation);
  setTimeout(() => {
    isWorking = false;
    setFace("idle", "animate-idle");
    startIdleLife();
  }, durationMs);
}

// --- Idle micro-animations (Pekáček "lives") ---
const IDLE_ACTIONS = [
  // [face, animation, durationMs, weight]
  { face: "idle",    anim: "animate-blink",   ms: 400,  w: 5 },  // blink
  { face: "wave",    anim: "animate-wave",    ms: 1200, w: 2 },  // wave
  { face: "idle",    anim: "animate-look",    ms: 1600, w: 3 },  // look around
  { face: "idle",    anim: "animate-stretch", ms: 1100, w: 2 },  // stretch
  { face: "idle",    anim: "animate-nod",     ms: 1300, w: 2 },  // nod
  { face: "coffee",  anim: "animate-idle",    ms: 2500, w: 1 },  // sip coffee
  { face: "idle",    anim: "animate-peek",    ms: 1300, w: 2 },  // peek to side
  { face: "curious", anim: "animate-idle",    ms: 2000, w: 1 },  // curious look
  { face: "chill",   anim: "animate-idle",    ms: 2500, w: 1 },  // chill
];

function pickIdleAction() {
  const totalWeight = IDLE_ACTIONS.reduce((sum, a) => sum + a.w, 0);
  let r = Math.random() * totalWeight;
  for (const action of IDLE_ACTIONS) {
    r -= action.w;
    if (r <= 0) return action;
  }
  return IDLE_ACTIONS[0];
}

function doIdleAction() {
  if (isWorking) return;

  const action = pickIdleAction();
  face.textContent = FACES[action.face] || FACES.idle;
  face.className = action.anim;

  // Return to idle breathing after action finishes
  setTimeout(() => {
    if (!isWorking) {
      face.textContent = FACES.idle;
      face.className = "animate-idle";
    }
  }, action.ms);
}

function startIdleLife() {
  stopIdleLife();
  // Random action every 4-10 seconds
  function scheduleNext() {
    const delay = 4000 + Math.random() * 6000;
    idleTimer = setTimeout(() => {
      doIdleAction();
      scheduleNext();
    }, delay);
  }
  scheduleNext();
}

function stopIdleLife() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

// --- Tab Info (always works, no content script needed) ---
function loadTabInfo(retryCount = 0) {
  chrome.runtime.sendMessage({ type: "get-tab-info" }, (res) => {
    if (!res || res.error) {
      pageIndicator.textContent = "—";
      return;
    }

    let title = (res.title || "").trim();
    const url = res.url || "";

    // If title is empty but URL exists, tab may still be loading — retry 1-2x
    if (!title && url && !url.startsWith("chrome://") && retryCount < 2) {
      setTimeout(() => loadTabInfo(retryCount + 1), 400);
      return;
    }

    // Fallback: use URL hostname if title still missing
    if (!title && url) {
      try {
        title = new URL(url).hostname.replace(/^www\./, "");
      } catch {}
    }

    pageIndicator.textContent = title ? truncate(title, 35) : "—";

    // Offer to read — ale jen pokud nemáme rozběhnutou konverzaci
    if (!articleRead && url && url !== lastReadUrl) {
      // Pokud aktuální session už má zprávy, uživatel s Pekáčkem mluvil → neopakovat nabídku
      if ((currentSession?.messages?.length || 0) > 0) return;

      const skipPatterns = [
        "google.com/search",
        "chrome://",
        "chrome-extension://",
        "about:",
        "newtab",
      ];
      if (skipPatterns.some((p) => url.includes(p))) return;

      // YouTube → specialized flow
      if (/youtube\.com\/watch|youtu\.be\//.test(url)) {
        offerYouTube(title || "YouTube video", url);
        return;
      }

      offerToRead(title || "tato stránka", url);
    }
  });
}

// Extract full page content (on demand — uses content script)
function extractPageContent() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "get-page-content" }, (res) => {
      if (res && !res.error) {
        currentPageContent = res;
        statusText.textContent = `${(res.length / 1000).toFixed(1)}k znaku`;
        resolve(res);
      } else {
        console.error("[Pekacek] extractPageContent error:", res?.error);
        resolve({ __error: res?.error || "Unknown error" });
      }
    });
  });
}

// Offer Pekáček to read the article (just from title+URL, no content script)
function offerToRead(title, url) {
  const msgId = addMessage("pekacek",
    `Vidím článek: **${truncate(title, 50)}**\n\n` +
    `Mám si ho přečíst? Pak budu rychlejší s dalšíma akcema.`
  );

  const msgEl = document.getElementById(msgId);
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "margin-top: 8px; display: flex; gap: 6px;";

  const readBtn = document.createElement("button");
  readBtn.textContent = "Přečti si ho";
  readBtn.style.cssText = "padding: 5px 12px; border: 1px solid var(--green); border-radius: 5px; background: rgba(78,204,163,0.15); color: var(--green); font-size: 12px; cursor: pointer;";
  readBtn.addEventListener("click", () => {
    btnRow.remove();
    readArticle(title, url);
  });

  const skipBtn = document.createElement("button");
  skipBtn.textContent = "Přeskoč";
  skipBtn.style.cssText = "padding: 5px 12px; border: 1px solid var(--text-muted); border-radius: 5px; background: transparent; color: var(--text-dim); font-size: 12px; cursor: pointer;";
  skipBtn.addEventListener("click", () => {
    btnRow.remove();
  });

  btnRow.appendChild(readBtn);
  btnRow.appendChild(skipBtn);
  msgEl.appendChild(btnRow);
}

// Offer YouTube-specific actions (shrň / watchlist / ingest)
async function offerYouTube(fallbackTitle, url) {
  const msgId = addMessage("pekacek",
    `Vidím YouTube video — chvilku…`
  );

  const data = await extractPageContent();
  const msgEl = document.getElementById(msgId);

  if (!data || data.__error || data.type !== "youtube") {
    // Content script failed (typicky YouTube ještě načítá) — fallback na obyčejný článek flow
    msgEl.remove();
    offerToRead(fallbackTitle, url);
    return;
  }

  const meta = [
    data.channel ? `📺 ${data.channel}` : null,
    data.duration ? `⏱ ${data.duration}` : null,
  ].filter(Boolean).join(" · ");

  msgEl.querySelector(".message-content").innerHTML = formatMessage(
    `Vidím YouTube video: **${truncate(data.title, 60)}**` +
    (meta ? `\n${meta}` : "") +
    `\n\nCo s tím?`
  );

  const btnCol = document.createElement("div");
  btnCol.style.cssText = "margin-top: 8px; display: flex; flex-direction: column; gap: 5px;";

  const actions = [
    { icon: "💬", label: "Shrň rychle (z popisku)", handler: () => summarizeYouTube(data) },
    { icon: "📝", label: "Shrň důkladně (s transcriptem)", handler: () => summarizeYouTubeWithTranscript(data) },
    { icon: "📄", label: "Zobraz transcript", title: "Klik = cache, Shift+Klik = force refresh", handler: (e) => showYouTubeTranscript(data, { force: !!e?.shiftKey }), keep: true },
    { icon: "🎬", label: "Film/seriál → přidat na ČSFD watchlist", handler: () => youtubeToWatchlist(data) },
    { icon: "📚", label: "Naučné → ingest do wiki", handler: () => ingestYouTube(data) },
    { icon: "⏭", label: "Přeskoč", handler: () => {} },
  ];

  for (const a of actions) {
    const btn = document.createElement("button");
    btn.textContent = `${a.icon}  ${a.label}`;
    if (a.title) btn.title = a.title;
    btn.style.cssText = "padding: 6px 10px; border: 1px solid var(--text-muted); border-radius: 5px; background: var(--bg-card); color: var(--text); font-size: 12px; cursor: pointer; text-align: left; font-family: var(--sans);";
    btn.addEventListener("mouseenter", () => { btn.style.borderColor = "var(--green)"; btn.style.color = "var(--green)"; });
    btn.addEventListener("mouseleave", () => { btn.style.borderColor = "var(--text-muted)"; btn.style.color = "var(--text)"; });
    btn.addEventListener("click", (e) => {
      if (!a.keep) btnCol.remove();
      a.handler(e);
    });
    btnCol.appendChild(btn);
  }

  msgEl.appendChild(btnCol);
}

function youtubeMetaBlock(data) {
  return (
    `Název: ${data.title}\n` +
    `Kanál: ${data.channel || "(neznámý)"}\n` +
    (data.duration ? `Délka: ${data.duration}\n` : "") +
    `URL: ${data.url}\n\n` +
    `Popis videa:\n${data.description || "(prázdný / YouTube nevrací description)"}`
  );
}

async function fetchYouTubeTranscript(videoId, { force = false } = {}) {
  const qs = `videoId=${encodeURIComponent(videoId)}${force ? "&force=1" : ""}`;
  const res = await fetch(`${BRIDGE_URL}/youtube/transcript?${qs}`);
  const payload = await res.json().catch(() => ({ error: "Neplatná odpověď bridge" }));
  if (!res.ok || payload.error) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload; // { transcript, language, length }
}

// Přeláme dlouhý jednolinkový text na čitelné odstavce.
// Preferuje sentence break (interpunkce), fallback po ~35 slovech.
function prettifyTranscript(text) {
  const hasPunct = /[.!?][ \n][A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(text);
  if (hasPunct) {
    return text.replace(/([.!?])\s+([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ])/g, "$1\n$2");
  }
  const words = text.split(/\s+/);
  const chunks = [];
  for (let i = 0; i < words.length; i += 35) {
    chunks.push(words.slice(i, i + 35).join(" "));
  }
  return chunks.join("\n");
}

async function showYouTubeTranscript(data, { force = false } = {}) {
  addMessage("user", force ? `📄 Ukaž transcript (force refresh)` : `📄 Ukaž transcript`);
  const placeholderId = addMessage("pekacek", force ? "Stahuji transcript znovu (bez cache)…" : "Stahuji transcript…", true);

  try {
    const t = await fetchYouTubeTranscript(data.videoId, { force });
    removeMessage(placeholderId);

    const lenKb = (t.length / 1000).toFixed(1);
    const id = `msg-${++messageCounter}`;
    const div = document.createElement("div");
    div.className = "message pekacek";
    div.id = id;
    div.dataset.rawText = t.transcript;

    const header = document.createElement("div");
    header.className = "message-content";
    header.innerHTML =
      `<strong>📄 Transcript</strong> ` +
      `<span style="color: var(--text-dim); font-size: 11px;">` +
      `(${t.language}, ${lenKb}k znaků)` +
      `</span>`;
    div.appendChild(header);

    const pre = document.createElement("pre");
    pre.className = "transcript-block";
    pre.textContent = prettifyTranscript(t.transcript);
    div.appendChild(pre);

    // Copy button (standard pekacek pattern)
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.title = "Zkopírovat transcript";
    copyBtn.textContent = "⧉";
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(t.transcript);
        copyBtn.textContent = "✓";
        copyBtn.classList.add("copied");
        setTimeout(() => { copyBtn.textContent = "⧉"; copyBtn.classList.remove("copied"); }, 1500);
      } catch {
        copyBtn.textContent = "✗";
        setTimeout(() => { copyBtn.textContent = "⧉"; }, 1500);
      }
    });
    div.appendChild(copyBtn);

    messagesEl.appendChild(div);
    scrollToBottom();
  } catch (err) {
    removeMessage(placeholderId);
    addMessage("pekacek", `Transcript se nepodařilo stáhnout: ${err.message}`);
    tempFace("worried", "animate-error");
  }
}

async function summarizeYouTubeWithTranscript(data) {
  addMessage("user", `📝 Shrň důkladně "${truncate(data.title, 40)}"`);
  const placeholderId = addMessage("pekacek", "Stahuji transcript přes yt-dlp…", true);

  try {
    const t = await fetchYouTubeTranscript(data.videoId);
    removeMessage(placeholderId);

    const lenKb = (t.length / 1000).toFixed(1);
    const prompt =
      `Uživatel chce kvalitní shrnutí YouTube videa z transcriptu.\n\n` +
      youtubeMetaBlock(data) + `\n\n` +
      `Transcript (jazyk: ${t.language}, ${lenKb}k znaků):\n---\n${t.transcript}\n---\n\n` +
      `Shrň strukturovaně:\n` +
      `(1) 1–2 věty o čem to je.\n` +
      `(2) 4–6 klíčových myšlenek v bulletech.\n` +
      `(3) Pro koho to je / komu to doporučit.\n` +
      `(4) Pokud je to naučné, navrhni jestli má smysl to ingestovat do wiki (a do jaké kategorie).`;

    sendToBridge(prompt, { saveArticle: true, articleTitle: data.title, action: "summarize" });
    articleRead = true;
    lastReadUrl = data.url;
  } catch (err) {
    removeMessage(placeholderId);
    addMessage("pekacek",
      `Transcript se nepodařilo stáhnout: ${err.message}\n\n` +
      `Nejspíš video nemá captions (nebo yt-dlp narazil na YT rate-limit). Shrnu z popisku.`
    );
    summarizeYouTube(data);
  }
}

function summarizeYouTube(data) {
  addMessage("user", `Shrň video "${truncate(data.title, 40)}"`);
  const prompt =
    `Uživatel se dívá na YouTube video. Pekáček nemá přístup k transcriptu, jen k metadatům a popisku. ` +
    `Na základě toho co máš: shrň o čem video je a co si z něj divák může odnést (pokud to jde odhadnout). ` +
    `Pokud je popis chudý nebo generický, řekni to upřímně — lepší než si vymýšlet. ` +
    `Ideálně na konci navrhni, jestli stojí za to pustit celé (a proč), nebo jestli to vypadá přeskočitelně.\n\n` +
    youtubeMetaBlock(data);
  sendToBridge(prompt, { saveArticle: true, articleTitle: data.title, action: "summarize" });
  articleRead = true;
  lastReadUrl = data.url;
}

function youtubeToWatchlist(data) {
  addMessage("user", `Je to film/seriál? Přidat na ČSFD watchlist`);
  const prompt =
    `Uživatel chce z YouTube videa případně přidat film nebo seriál na svůj ČSFD watchlist.\n\n` +
    youtubeMetaBlock(data) + `\n\n` +
    `Postup:\n` +
    `1) Vyhodnoť z názvu a kanálu, jestli jde o **samotný film nebo seriál** (ne trailer, ne recenze, ne video esej, ne reakce).\n` +
    `2) Pokud je to jasný titul filmu/seriálu: zavolej \`mcp__csfd__search\` s názvem (očisti ho — odstraň "(official)", "HD", "4K", "full movie", rok v závorkách atd.). Pokud najdeš přesvědčivý match, přidej ho přes \`node csfd-rate.mjs watchlist-add <csfd-url>\` a potvrď.\n` +
    `3) Pokud je to video *o* filmu (rozbor, trailer, recenze): zeptej se uživatele jaký film by měl dostat na watchlist — odvoď ze názvu a nabídni ho.\n` +
    `4) Pokud to vůbec není filmový obsah, řekni to a neprováděj žádnou akci.`;
  sendToBridge(prompt, { action: "quick" });
}

async function ingestYouTube(data) {
  addMessage("user", `📚 Ingest YouTube videa do wiki`);
  const placeholderId = addMessage("pekacek", "Stahuji transcript (pokud existuje)…", true);

  let transcriptBlock = "";
  try {
    const t = await fetchYouTubeTranscript(data.videoId);
    const lenKb = (t.length / 1000).toFixed(1);
    transcriptBlock = `\n\nTranscript (jazyk: ${t.language}, ${lenKb}k znaků):\n---\n${t.transcript}\n---\n`;
  } catch {
    transcriptBlock = `\n\n⚠ Transcript není dostupný (yt-dlp selhal / video bez captions) — pracuj jen s popiskem.\n`;
  }
  removeMessage(placeholderId);

  const prompt =
    `Uživatel chce ingestovat tento YouTube obsah do wiki. Zpracuj podle CLAUDE.md ingest workflow — ` +
    `urči kategorii, vytvoř wiki stránku, propoj s existujícími přes [[wiki-links]], aktualizuj index.md a log.md.\n\n` +
    `**Vstup je YouTube video.** Pokud máš transcript, extrahuj z něj klíčové myšlenky (stejně jako u článku). ` +
    `Pokud transcript chybí a popis je chudý, založ jen metadata stránku s odkazem a poznámkou ` +
    `"⚠ bez transcriptu — doplnit po zhlédnutí". Do frontmatter / metadat dej status \`chci-videt\` pokud ` +
    `je to něco co se má teprve pustit, nebo \`videno\` pokud uživatel dodá že už to viděl.\n\n` +
    youtubeMetaBlock(data) + transcriptBlock;

  sendToBridge(prompt, { action: "ingest" });
}

// Read article into session + give opinion
async function readArticle(title, url) {
  addMessage("user", "Přečti si ten článek");

  // Now extract content (content script runs here)
  const page = await extractPageContent();
  if (!page || page.__error) {
    const errDetail = page?.__error ? `\n\nDetail: ${page.__error}` : "";
    addMessage("pekacek",
      `Nepodařilo se přečíst obsah stránky. Zkus refreshnout stránku (F5) a znovu otevřít sidebar.${errDetail}`
    );
    tempFace("worried", "animate-error");
    return;
  }

  const prompt =
    `Uživatel je na stránce "${title}" (${url}). ` +
    `Přečti si článek a zapamatuj si ho — budou následovat další otázky. ` +
    `Teď mi dej svůj názor na 3-4 věty: co je hlavní myšlenka, co tě zaujalo, ` +
    `a jestli s něčím nesouhlasíš nebo ti něco chybí.\n\n` +
    `Obsah článku:\n${page.text}`;

  await sendToBridge(prompt, { saveArticle: true, articleTitle: title, action: "read" });

  articleRead = true;
  lastReadUrl = url;
}

// Ensure page content is loaded for actions (extract if needed)
async function ensurePageContent() {
  if (!currentPageContent) {
    await extractPageContent();
  }
  return currentPageContent;
}

// Refresh on focus
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    loadTabInfo();
    checkBridgeStatus();
    // User is looking at sidebar again — clear badge
    try { chrome.runtime.sendMessage({ type: "clear-badge" }, () => {}); } catch {}
  }
});

// Listen for tab URL changes (SPA navigations fire chrome.tabs.onUpdated in background).
// Reset page-state so stale YT offer doesn't linger with wrong videoId.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "tab-url-changed") return;
  const newUrl = msg.url || "";
  if (!newUrl || newUrl === lastReadUrl) return;
  currentPageContent = null;
  articleRead = false;
  lastReadUrl = null;
  loadTabInfo();
});

// --- Dropdown toggles ---
function closeAllDropdowns() {
  document.querySelectorAll(".dropdown-menu.open").forEach((m) => m.classList.remove("open"));
  document.querySelectorAll(".dropdown-toggle.open, #quick-btn.open").forEach((t) => t.classList.remove("open"));
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".action-dropdown, #quick-dropdown")) closeAllDropdowns();
});

// --- Film mood/length picker builder ---
const FILM_MOOD_DESC = {
  oddychove: "oddychové / chill / nic těžkého",
  akcni: "akční / adrenalinové",
  napinave: "napínavé (chci se bát — thrillery, horor, napětí)",
  hlubsi: "přemýšlivé / náročné / drama / intenzivní",
  humor: "humor / komedie",
  romanticke: "romantické",
  feelgood: "feel-good / pohlazení po duši",
  temne: "temné / mrazivé atmosféry",
  vizualni: "vizuálně pěkné (kamera, design, estetika)",
};
const FILM_MOOD_SHORT = {
  oddychove: "oddych", akcni: "akce", napinave: "bát se", hlubsi: "hlubší",
  humor: "humor", romanticke: "roman", feelgood: "feel-good", temne: "temné", vizualni: "vizuální",
};
const FILM_LENGTH_DESC = {
  short: "kratší (pod 90 min)",
  standard: "standardní délka (90–120 min)",
  long: "delší (nad 120 min)",
  any: "jakákoliv délka",
};

function buildFilmPrompt() {
  const moods = [...document.querySelectorAll("#film-moods .chip.active")].map((c) => c.dataset.mood);
  const length = document.querySelector("#film-length .chip.active")?.dataset.length || "any";
  const source = document.querySelector("#film-source .chip.active")?.dataset.source || "watchlist";

  const moodStr = moods.length > 0
    ? moods.map((m) => FILM_MOOD_DESC[m]).join("; ")
    : "bez konkrétní náladové preference — vybírej univerzálně";
  const lengthNote = length === "any" ? "" : ` Délka: ${FILM_LENGTH_DESC[length]}.`;

  const shortMood = moods.length > 0
    ? moods.map((m) => FILM_MOOD_SHORT[m]).join(" + ")
    : "libovolné";
  const shortLen = length === "any" ? "" : ` · ${FILM_LENGTH_DESC[length]}`;
  const sourceLabel = source === "csfd" ? "ČSFD" : "watchlist";

  const promptBody = source === "csfd"
    ? `Doporuč mi film z celé ČSFD databáze (klidně i filmy které nemám ve watchlistu). Nálada: ${moodStr}.${lengthNote} Použij \`mcp__csfd__search\` pro hledání a \`mcp__csfd__get_movie\` pro ověření žánrů a hodnocení. Vyber 3 tituly — u každého řádek proč + rok, žánr, délka a ČSFD hodnocení. Preferuj filmy s hodnocením ≥ 70 %. Pokud film nemám ve watchlistu, zmíním to na konci řádku (např. "— mimo watchlist").`
    : `Doporuč mi film z mého ČSFD watchlistu. Použij \`node csfd-rate.mjs watchlist --all\` (pokud známe žánry, přidej \`--genre=<id|nazev>[,...]\` pro přesné filtrování, např. \`--genre=horor,komedie\`). Nálada: ${moodStr}.${lengthNote} Vyber 3 tituly které nejlépe sedí — u každého krátce (1 řádek) proč se hodí, plus pokud snadno zjistíš, doplň délku + žánr + rok.`;

  return {
    label: `Doporuč film (${shortMood}${shortLen} · ${sourceLabel})`,
    prompt: promptBody,
  };
}

// --- Recept picker ---
const RECEPT_TYPE_DESC = {
  snidane: "snídaně", obed: "oběd", vecere: "večeře",
  dezert: "dezert", polevka: "polévka", svacina: "svačina",
};
const RECEPT_MOOD_DESC = {
  rychlovka: "rychlovka", comfort: "comfort food", zdrave: "zdravé / lehké",
  party: "párty", romanticke: "romantické", letni: "letní / svěží", podzimni: "podzimní / zahřívací",
};
const RECEPT_TIME_DESC = {
  short: "do 20 min", medium: "20–45 min", long: "přes 45 min", any: "libovolný",
};
const RECEPT_DIET_DESC = {
  vegetarian: "vegetariánské", vegan: "veganské", glutenfree: "bezlepkové", any: "bez omezení",
};

function buildReceptPrompt() {
  const types = [...document.querySelectorAll("#recept-type .chip.active")].map((c) => c.dataset.type);
  const moods = [...document.querySelectorAll("#recept-mood .chip.active")].map((c) => c.dataset.mood);
  const time = document.querySelector("#recept-time .chip.active")?.dataset.time || "any";
  const diet = document.querySelector("#recept-diet .chip.active")?.dataset.diet || "any";

  const typeStr = types.length ? types.map((t) => RECEPT_TYPE_DESC[t]).join(" / ") : "libovolný typ";
  const moodStr = moods.length ? moods.map((m) => RECEPT_MOOD_DESC[m]).join("; ") : "bez konkrétní nálady";
  const timeNote = time === "any" ? "" : ` Čas přípravy: ${RECEPT_TIME_DESC[time]}.`;
  const dietNote = diet === "any" ? "" : ` Dieta: ${RECEPT_DIET_DESC[diet]}.`;

  const labelParts = [];
  if (types.length) labelParts.push(types.map((t) => RECEPT_TYPE_DESC[t]).join(" + "));
  if (moods.length) labelParts.push(moods.map((m) => RECEPT_MOOD_DESC[m]).join(" + "));
  if (time !== "any") labelParts.push(RECEPT_TIME_DESC[time]);
  if (diet !== "any") labelParts.push(RECEPT_DIET_DESC[diet]);
  const labelSuffix = labelParts.length ? ` (${labelParts.join(" · ")})` : "";

  return {
    label: `Doporuč recept${labelSuffix}`,
    prompt: `Mám chuť na něco z receptů. Preference — typ jídla: ${typeStr}; nálada: ${moodStr}.${timeNote}${dietNote}\n\n` +
      `Projdi \`wiki/recepty/\` pomocí \`grep\` na frontmatter řádky (**Typ jídla**:, **Nálada**:, **Čas**:, **Dieta**:). ` +
      `Vyber 2–3 recepty které nejlépe odpovídají. U každého 1 řádek proč + čas + status. ` +
      `Preferuj \`oblíbené\` a \`vyzkoušeno\` před \`chci-vyzkoušet\`. Pokud nic nesedí přesně, řekni to a navrhni nejbližší alternativu.`,
  };
}

// --- Book picker ---
const BOOK_FORMAT_DESC = {
  kniha: "papírová kniha", ekniha: "ekniha", audiokniha: "audiokniha",
};
const BOOK_MOOD_DESC = {
  napinave: "napínavé / thriller",
  oddychove: "oddychové / chill",
  temne: "temné / mrazivé",
  humor: "humor / satira",
  hlubsi: "hlubší / přemýšlivé",
  romantika: "romantické",
};
const BOOK_LENGTH_DESC = {
  short: "krátká (do ~250 stran / do ~6 h audio)",
  standard: "standardní délka",
  long: "delší (přes ~500 stran / přes ~15 h audio)",
  any: "libovolná délka",
};

function buildBookPrompt() {
  const formats = [...document.querySelectorAll("#book-format .chip.active")].map((c) => c.dataset.format);
  const moods = [...document.querySelectorAll("#book-mood .chip.active")].map((c) => c.dataset.mood);
  const length = document.querySelector("#book-length .chip.active")?.dataset.length || "any";

  const formatStr = formats.length ? formats.map((f) => BOOK_FORMAT_DESC[f]).join(" / ") : "libovolný formát";
  const moodStr = moods.length ? moods.map((m) => BOOK_MOOD_DESC[m]).join("; ") : "bez konkrétní nálady";
  const lengthNote = length === "any" ? "" : ` Délka: ${BOOK_LENGTH_DESC[length]}.`;

  const labelParts = [];
  if (formats.length) labelParts.push(formats.join(" + "));
  if (moods.length) labelParts.push(moods.join(" + "));
  if (length !== "any") labelParts.push(BOOK_LENGTH_DESC[length].split(" ")[0]);
  const labelSuffix = labelParts.length ? ` (${labelParts.join(" · ")})` : "";

  return {
    label: `Doporuč knihu${labelSuffix}`,
    prompt: `Doporuč mi knihu z \`wiki/kultura/knihy/\`. Preference — formát: ${formatStr}; nálada: ${moodStr}.${lengthNote}\n\n` +
      `Projdi stránky v \`wiki/kultura/knihy/\`, filtruj podle frontmatter (**Typ**:, **Nálada**:, **Délka**:, **Status**:). ` +
      `Vyber 2–3 tituly které nejlépe sedí — u každého řádek proč + autor + formát + délka. ` +
      `Preferuj status \`chci-přečíst\` / \`chci-poslechnout\` / rozečtené před již přečtenými. ` +
      `Pokud je výběr prázdný nebo málo položek, řekni to upřímně.`,
  };
}

// --- Quick action prompts ---
const QUICK_ACTIONS = {
  "divadlo": {
    label: "Co v divadle?",
    prompt: "Co mám ve `wiki/kultura/divadlo/`? Vypiš představení se statusem `chci-vidět` nebo `mám-lístek` — krátký seznam (název + divadlo + žánr + termín pokud je). Pokud je sekce prázdná, napiš to.",
  },
  "lab": {
    label: "Co dneska z labu?",
    prompt: "Podívej se do `wiki/lab/index.md` a souvisejících lab stránek. Doporuč mi jeden konkrétní experiment nebo úkol který by šlo dneska posunout — podle zralosti, rozpracovanosti a toho co by šlo reálně dotáhnout. Stručně proč právě tenhle a jaký by byl první krok.",
  },
  "articles": {
    label: "Co dnes číst z nepřečtených článků?",
    prompt: "Co mám nepřečtené v `wiki/clanky/` (status: chci-precist)? Doporuč mi 3 články které bych si dnes mohl přečíst — krátký název + řádek proč právě tenhle. Zohledni že mám omezený čas, tak zvol mix lehčích + jednoho náročnějšího.",
  },
  "today": {
    label: "Co mám dneska?",
    prompt: "Co mám dnes za události v kalendáři a nepřečtené důležité emaily? Krátký souhrn toho co stojí za pozornost — bez blabolu, jen podstata.",
  },
};

// --- Dashboard (📰 · 📬 · 📅) ---
const DASHBOARD_POLL_MS = 3000;
let dashboardPollTimer = null;

async function loadDashboard() {
  try {
    const res = await fetch(`${BRIDGE_URL}/dashboard`);
    if (!res.ok) return;
    const data = await res.json();
    renderDashboard(data);

    if (dashboardPollTimer) { clearTimeout(dashboardPollTimer); dashboardPollTimer = null; }
    if (data.pending) {
      dashboardPollTimer = setTimeout(loadDashboard, DASHBOARD_POLL_MS);
    }
  } catch {
    // Bridge offline — chip zůstane s "—"
  }
}

function eventBadge(daysUntil) {
  if (daysUntil === 0) return "dnes";
  if (daysUntil === 1) return "zítra";
  if (daysUntil <= 14) return `za ${daysUntil}d`;
  return "—";
}

function renderDashboard(data) {
  document.getElementById("dash-n-articles").textContent = data.articles?.count ?? "—";
  document.getElementById("dash-n-emails").textContent =
    data.emails ? data.emails.count : (data.pending ? "…" : "—");

  const next = data.events?.next;
  let nextLabel;
  if (next) nextLabel = eventBadge(next.daysUntil);
  else if (data.pending && !data.events) nextLabel = "…";
  else nextLabel = "—";
  document.getElementById("dash-next-event").textContent = nextLabel;

  // Section heads
  document.getElementById("dash-head-articles").textContent = data.articles ? `(${data.articles.count})` : "";
  document.getElementById("dash-head-emails").textContent = data.emails ? `(${data.emails.count})` : "";
  document.getElementById("dash-head-events").textContent = data.events ? `(${data.events.count})` : "";

  // Articles — clickable (trigger read)
  renderDashSection("articles", data.articles, data.pending, (a) => {
    const btn = document.createElement("button");
    btn.className = "dash-item";
    btn.textContent = a.title;
    btn.title = a.file;
    btn.addEventListener("click", () => openArticleFromDashboard(a));
    return btn;
  }, "— žádné nepřečtené —");

  // Emails — read-only rows
  renderDashSection("emails", data.emails, data.pending, (e) => {
    const row = document.createElement("div");
    row.className = "dash-item dash-readonly";
    const from = dashTruncate(e.from || "(neznámý)", 22);
    const subj = dashTruncate(e.subject || "(bez předmětu)", 38);
    row.innerHTML = `<strong>${escapeHtml(from)}</strong> — ${escapeHtml(subj)}`;
    row.title = `${e.from || ""}: ${e.subject || ""}`;
    return row;
  }, "— inbox čistý —");

  // Events — read-only with daysUntil prefix
  renderDashSection("events", data.events, data.pending, (ev) => {
    const row = document.createElement("div");
    row.className = "dash-item dash-readonly";
    const when = eventBadge(ev.daysUntil);
    const timeStr = ev.time ? ` ${ev.time}` : "";
    row.innerHTML = `<strong>${escapeHtml(when)}${escapeHtml(timeStr)}</strong>: ${escapeHtml(dashTruncate(ev.title || "", 38))}`;
    row.title = `${ev.date || ""}${timeStr} — ${ev.title || ""}`;
    return row;
  }, "— nic v 14 dnech —");

  // Last updated
  const upd = document.getElementById("dash-updated");
  if (data.updatedAt) {
    const ageMin = Math.round((Date.now() - data.updatedAt) / 60000);
    upd.textContent = ageMin < 1 ? "Aktualizováno < 1 min" : `Aktualizováno před ${ageMin} min`;
  } else {
    upd.textContent = data.pending ? "Načítám…" : "—";
  }
}

function renderDashSection(key, section, pending, itemBuilder, emptyMsg) {
  const el = document.getElementById(`dash-${key}-list`);
  el.innerHTML = "";
  if (!section) {
    el.textContent = pending ? "Načítám…" : "—";
    el.classList.add("dash-empty");
    return;
  }
  const list = section.list || [];
  if (list.length === 0) {
    el.textContent = emptyMsg;
    el.classList.add("dash-empty");
    return;
  }
  el.classList.remove("dash-empty");
  for (const item of list.slice(0, 8)) {
    el.appendChild(itemBuilder(item));
  }
}

function dashTruncate(str, len) {
  return str.length > len ? str.slice(0, len) + "…" : str;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function openArticleFromDashboard(article) {
  document.getElementById("dashboard-detail").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("open");
  addMessage("user", `Koukni na ${article.title}`);
  sendToBridge(
    `Přečti prosím wiki stránku \`${article.file}\` a krátce shrň (hlavní myšlenky, co je zajímavé, 3–5 vět). ` +
    `Neupravuj soubor — jen přečti a shrň. Na konci napiš jestli ji doporučuješ označit \`precteno\` (stojí za to), ` +
    `\`zamitnuto\` (není to to co čekal), nebo nechat v \`chci-precist\`.`,
    { action: "quick" }
  );
}

// Chip click → toggle detail
document.getElementById("dashboard-chip").addEventListener("click", () => {
  const detail = document.getElementById("dashboard-detail");
  const root = document.getElementById("dashboard");
  detail.classList.toggle("hidden");
  root.classList.toggle("open", !detail.classList.contains("hidden"));
});

// Refresh button — invalidates cache and re-polls
document.getElementById("dash-refresh").addEventListener("click", async () => {
  document.getElementById("dash-updated").textContent = "Načítám…";
  try {
    await fetch(`${BRIDGE_URL}/dashboard/refresh`, { method: "POST" });
  } catch {}
  loadDashboard();
});

// Re-poll on tab focus
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadDashboard();
});

// --- Accordion state persistence (pekacek-sections) ---
const ACCORDION_KEY = "pekacek.accordion.open";
(function initAccordion() {
  const saved = localStorage.getItem(ACCORDION_KEY);
  const sections = document.querySelectorAll("details.accordion");
  if (saved) {
    const target = document.querySelector(`details.accordion[data-section="${saved}"]`);
    if (target) {
      sections.forEach((d) => { d.open = (d === target); });
    }
  }
  sections.forEach((d) => {
    d.addEventListener("toggle", () => {
      if (d.open) localStorage.setItem(ACCORDION_KEY, d.dataset.section);
    });
  });
})();

// --- Quick dropdown (⚡ u send buttonu) ---
document.getElementById("quick-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = document.getElementById("quick-menu");
  const btn = e.currentTarget;
  const wasOpen = menu.classList.contains("open");
  closeAllDropdowns();
  if (!wasOpen) {
    menu.classList.add("open");
    btn.classList.add("open");
  }
});

document.getElementById("quick-menu").addEventListener("click", (e) => {
  // Chip toggles (neuzavírej menu, jen přepni stav)
  const chip = e.target.closest(".chip");
  if (chip) {
    const group = chip.closest(".chip-group");
    if (group?.classList.contains("chip-single")) {
      group.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
    } else {
      chip.classList.toggle("active");
    }
    return;
  }

  // Akční položky v menu — zavři menu a odešli prompt
  const item = e.target.closest(".dropdown-item[data-quick]");
  if (!item) return;
  closeAllDropdowns();

  const quickId = item.dataset.quick;
  const builders = {
    "film-custom": buildFilmPrompt,
    "recept-custom": buildReceptPrompt,
    "book-custom": buildBookPrompt,
  };
  const qa = builders[quickId] ? builders[quickId]() : QUICK_ACTIONS[quickId];
  if (!qa) return;
  addMessage("user", qa.label);
  sendToBridge(qa.prompt, { action: "quick" });
});

// --- Keyboard shortcuts (Alt+1..5 = top buttons, Alt+Q = quick menu) ---
document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

  // Alt+Q — quick ⚡ menu
  if (e.key === "q" || e.key === "Q") {
    e.preventDefault();
    document.getElementById("quick-btn").click();
    return;
  }

  // Alt+1..5 — top action buttons
  if (/^[1-5]$/.test(e.key)) {
    const btn = document.querySelector(`#actions [data-shortcut="${e.key}"]`);
    if (btn) {
      e.preventDefault();
      btn.click();
    }
  }
});

// --- Actions ---
document.getElementById("actions").addEventListener("click", (e) => {
  // Dropdown toggle (Vysvětli ▾)
  const toggle = e.target.closest(".dropdown-toggle");
  if (toggle) {
    const menu = document.getElementById(`dropdown-${toggle.dataset.dropdown}`);
    const wasOpen = menu?.classList.contains("open");
    closeAllDropdowns();
    if (!wasOpen) {
      menu?.classList.add("open");
      toggle.classList.add("open");
    }
    return;
  }

  // Dropdown item selected — close menu, fall through to action dispatch
  const item = e.target.closest(".dropdown-item");
  if (item) {
    closeAllDropdowns();
  }

  const btn = item || e.target.closest(".action-btn");
  if (!btn) return;

  const action = btn.dataset.action;
  if (action === "save") return handleSave();
  if (action === "ingest") return handleIngest();

  // Ensure we have page content (extract if needed)
  ensurePageContent().then((content) => {
    if (!content) {
      addMessage("pekacek", "Nepodařilo se přečíst stránku. Zkus refreshnout a znovu.");
      tempFace("worried", "animate-error");
      return;
    }

    const text = currentPageContent.selection || currentPageContent.text;
    const pageCtx = `Stránka: "${currentPageContent.title}"\nURL: ${currentPageContent.url}\n`;

    // If article already read into session, use short prompts (no full text resend)
    const hasContext = articleRead && currentPageContent.url === lastReadUrl;
    const ctxNote = hasContext
      ? `(Článek už máš přečtený v této session — nepotřebuješ ho znovu.)\n`
      : `${pageCtx}\nObsah:\n${text}`;

    const prompts = {
      summarize: hasContext
        ? `Shrň článek co už máš přečtený — klíčové myšlenky, co je nové/zajímavé. Pokud to souvisí s wiki, zmiň to.`
        : `Uživatel čte článek v Chrome sidebar panelu. Shrň ho stručně — klíčové myšlenky, co je nové/zajímavé. Pokud to souvisí s něčím ve wiki, zmiň to.\n\n${pageCtx}\nObsah:\n${text}`,
      counter: hasContext
        ? `K tomu článku co už znáš — najdi slabiny, protimyšlenky a neověřená tvrzení. Buď konstruktivně kritický.`
        : `Uživatel čte článek. Najdi slabiny, protimyšlenky a neověřená tvrzení. Buď konstruktivně kritický.\n\n${pageCtx}\nObsah:\n${text}`,
      experiment: hasContext
        ? `K tomu článku — navrhni 2-3 praktické experimenty nebo způsoby jak ověřit tvrzení. Něco co může reálně zkusit.`
        : `Uživatel čte článek. Navrhni 2-3 praktické experimenty nebo způsoby jak ověřit tvrzení. Něco co může reálně zkusit.\n\n${pageCtx}\nObsah:\n${text}`,
      analogy: hasContext
        ? `K tomu článku — vysvětli hlavní koncepty pomocí ANALOGIÍ z běžného života. "Je to jako když..." Pro každý klíčový koncept. Analogie z vaření, sportu, stavění domu, cestování. Přesné, ne jen hezké.`
        : `Uživatel čte článek a chce ho lépe pochopit. Vysvětli hlavní koncepty pomocí ANALOGIÍ z běžného života. Pro každý klíčový koncept najdi přirovnání které ho zpřístupní ("je to jako když..."). Použij analogie z vaření, sportu, stavění domu, cestování — cokoli intuitivního. Nezjednodušuj až moc — analogie má být přesná, ne jen hezká.\n\n${pageCtx}\nObsah:\n${text}`,
      diagram: hasContext
        ? `K tomu článku — nakresli ASCII diagramy hlavních konceptů: flowcharty, hierarchie, časové osy, srovnávací tabulky, relační mapy. Více diagramů pokud pokrývá víc témat. Ke každému 1-2 věty vysvětlení. Code bloky.`
        : `Uživatel čte článek a chce VIZUALIZACI hlavních konceptů. Nakresli ASCII diagramy: flowcharty (šipky →, ↓, boxes [ ]), hierarchie (stromečky), časové osy, srovnávací tabulky, nebo relační mapy. Použij více diagramů pokud článek pokrývá víc témat. Ke každému diagramu přidej 1-2 věty vysvětlení. Formátuj diagramy v code blocích.\n\n${pageCtx}\nObsah:\n${text}`,
      eli5: hasContext
        ? `K tomu článku — vysvětli to jako pětiletému dítěti. Krátké věty, žádný odborný jazyk, konkrétní příklady z dětského světa. Ale zachovej jádro myšlenky.`
        : `Uživatel čte článek a chce úplně jednoduché vysvětlení. Vysvětli to jako bys to vysvětloval zvědavému pětiletému dítěti — krátké věty, žádný odborný jazyk, konkrétní příklady z dětského světa. Ale zachovej jádro myšlenky — ELI5 neznamená nepřesný.\n\n${pageCtx}\nObsah:\n${text}`,
      simplify: hasContext
        ? `K tomu článku — vysvětli to laikovi. Bez odborného žargonu, ale plnohodnotně. Krátké srozumitelné věty, vysvětli termíny v závorkách při prvním použití. Cílová skupina: inteligentní dospělý člověk bez odborného backgroundu v oboru.`
        : `Uživatel čte článek a chce srozumitelné vysvětlení bez odborného žargonu. Vysvětli to laikovi — plnohodnotně, ale bez expert-speak. Krátké srozumitelné věty, vysvětli termíny v závorkách při prvním použití. Cílová skupina: inteligentní dospělý člověk bez backgroundu v oboru.\n\n${pageCtx}\nObsah:\n${text}`,
      technical: hasContext
        ? `K tomu článku — vysvětli to odborně, s technickými detaily. Předpokládej, že uživatel má background v oboru. Používej přesnou terminologii, zmiň relevantní standardy, architektonické detaily, edge cases a trade-offs. Žádné zjednodušování.`
        : `Uživatel čte článek a chce expertní vysvětlení. Vysvětli to odborně, s technickými detaily. Předpokládej background v oboru — přesná terminologie, relevantní standardy, architektonické detaily, edge cases a trade-offs. Žádné zjednodušování.\n\n${pageCtx}\nObsah:\n${text}`,
    };

    const userMsg = prompts[action];
    if (!userMsg) return;

    const labels = {
      summarize: "Shrň tuhle stránku",
      counter: "Najdi slabiny a protimyšlenky",
      experiment: "Navrhni experimenty k ověření",
      analogy: "Vysvětli pomocí analogií",
      diagram: "Nakresli diagram konceptu",
      eli5: "Vysvětli jako pětiletému",
      simplify: "Vysvětli zjednodušeně, bez žargonu",
      technical: "Vysvětli odborně, s detaily",
    };
    addMessage("user", labels[action]);
    sendToBridge(userMsg, { action });
  });
});

// --- Save to _raw ---
async function handleSave() {
  if (!currentPageContent) await ensurePageContent();
  if (!currentPageContent) {
    addMessage("pekacek", "Není co uložit — otevři stránku.");
    return;
  }

  chrome.runtime.sendMessage(
    { type: "save-to-raw", url: currentPageContent.url, title: currentPageContent.title },
    (res) => {
      if (res?.success) {
        addMessage("pekacek", `Uloženo do _raw: "${truncate(currentPageContent.title, 40)}"`);
        tempFace("dancing", "animate-dance", 2500);
      } else {
        addMessage("pekacek", `Chyba: ${res?.error || "neznámá"}`);
        tempFace("worried", "animate-error");
      }
    }
  );
}

// --- Direct ingest ---
async function handleIngest() {
  if (!currentPageContent) await ensurePageContent();
  if (!currentPageContent) {
    addMessage("pekacek", "Není co ingestovat — otevři stránku.");
    return;
  }

  addMessage("user", "Ingestuj tuhle stránku do wiki");

  const prompt =
    `Uživatel chce ingestovat tuto stránku do wiki. Zpracuj ji podle ingest workflow v CLAUDE.md — ` +
    `urči kategorii, vytvoř wiki stránku, propoj s existujícími stránkami, aktualizuj index.md a log.md.\n\n` +
    `Stránka: "${currentPageContent.title}"\nURL: ${currentPageContent.url}\n\nObsah:\n${currentPageContent.text}`;

  sendToBridge(prompt, { action: "ingest" });
}

// --- Chat ---
sendBtn.addEventListener("click", handleUserMessage);
userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleUserMessage();
  }
});

function handleUserMessage() {
  const text = userInput.value.trim();
  if (!text) return;

  userInput.value = "";
  addMessage("user", text);

  // Include page context only if article not already read
  let fullMsg = text;
  const hasCtx = articleRead && currentPageContent?.url === lastReadUrl;
  if (currentPageContent && !hasCtx) {
    const pageText = currentPageContent.selection || currentPageContent.text;
    fullMsg =
      `Kontext stránky (uživatel ji čte v Chrome): "${currentPageContent.title}" (${currentPageContent.url})\n` +
      `Text: ${pageText.slice(0, 8000)}\n\n---\nDotaz uživatele: ${text}`;
  }

  sendToBridge(fullMsg);
}

// --- Bridge communication (SSE streaming) ---

// Contextual thinking messages per action
const THINKING_MESSAGES = {
  summarize:  ["Shrnuju...", "Filtruju podstatu...", "Hledám hlavní linii...", "Skládám dohromady..."],
  counter:    ["Hledám slabiny...", "Vrtám do argumentů...", "Co tam chybí?...", "Zkouším protiargumenty..."],
  experiment: ["Vymýšlím experimenty...", "Jak to ověřit?...", "Hledám způsoby...", "Co bys mohl zkusit?..."],
  analogy:    ["Hledám přirovnání...", "Z které domény?...", "Je to jako když...", "Stavím analogii..."],
  diagram:    ["Kreslím diagram...", "Rozkládám koncepty...", "Jaká struktura?...", "Formátuju ASCII..."],
  eli5:       ["Zjednodušuju...", "Hledám správná slova...", "Tak aby to dítě pochopilo...", "Bez žargonu..."],
  simplify:   ["Odbourávám žargon...", "Hledám srozumitelná slova...", "Tak aby to pochopil každý...", "Vysvětluju v závorkách..."],
  technical: ["Vytahuju detaily...", "Hledám přesné termíny...", "Edge cases a trade-offs...", "Bez zjednodušování..."],
  ingest:     ["Čtu článek...", "Určuju kategorii...", "Vytvářím stránku...", "Propojuju s wiki..."],
  pin:        ["Určuju kategorii...", "Vytvářím stránku...", "Updatuju index...", "Zapisuju do logu..."],
  quick:      ["Koukám...", "Hledám to nejlepší...", "Procházím seznam...", "Zvažuju možnosti..."],
  read:       ["Čtu článek...", "Zpracovávám myšlenky...", "Formuluju názor...", "Hledám zajímavé...", "Skoro hotovo..."],
  default:    ["Přemýšlím...", "Ještě chvilku...", "Skoro to mám...", "Formuluju..."],
};

const THINKING_FACES = ["thinking", "curious", "determined", "thinking", "reading"];

let thinkingRotation = null;

function startThinkingMessages(action) {
  const msgs = THINKING_MESSAGES[action] || THINKING_MESSAGES.default;
  let idx = 0;
  let faceIdx = 0;

  statusText.textContent = msgs[0];
  statusText.style.color = "#ffd369";

  // Rotate messages every 4-6 seconds, faces every 2.5s
  thinkingRotation = setInterval(() => {
    idx = (idx + 1) % msgs.length;
    statusText.textContent = msgs[idx];
  }, 4500);

  // Face cycling (separate interval, faster)
  const faceInterval = setInterval(() => {
    if (!isWorking) {
      clearInterval(faceInterval);
      return;
    }
    faceIdx = (faceIdx + 1) % THINKING_FACES.length;
    const anim = faceIdx % 2 === 0 ? "animate-thinking" : "animate-idle";
    setFace(THINKING_FACES[faceIdx], anim);
  }, 2800);
}

function stopThinkingMessages() {
  if (thinkingRotation) {
    clearInterval(thinkingRotation);
    thinkingRotation = null;
  }
}

async function sendToBridge(prompt, extra = {}) {
  isWorking = true;
  stopIdleLife();
  setFace("thinking", "animate-thinking");
  startThinkingMessages(extra.action);
  showStopBtn();

  // Create empty message that we'll fill with streamed tokens
  const msgId = addMessage("pekacek", "", true);
  const msgEl = document.getElementById(msgId);
  const contentEl = msgEl.querySelector(".message-content");
  contentEl.className = "message-content"; // remove loading-dots
  let fullText = "";
  let wasStopped = false;

  const abortCtrl = new AbortController();
  currentAbortCtrl = abortCtrl;

  try {
    const response = await fetch(`${BRIDGE_URL}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        pageUrl: currentPageContent?.url || null,
        claudeSessionId: currentSession?.claudeSessionId || null,
        ...extra,
      }),
      signal: abortCtrl.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      contentEl.innerHTML = formatMessage(`Chyba: ${err}`);
      tempFace("worried", "animate-error");
      statusText.textContent = "Chyba";
      statusText.style.color = "#e94560";
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));

          if (event.type === "session-start") {
            currentStreamId = event.reqId;
          } else if (event.type === "claude-session") {
            // Bridge captured Claude's session_id — persist for future --resume
            if (currentSession && event.sessionId) {
              currentSession.claudeSessionId = event.sessionId;
              persistCurrentSession();
            }
          } else if (event.type === "stopped") {
            wasStopped = true;
            const stoppedText = (fullText || "") + "\n\n_(přerušeno)_";
            contentEl.innerHTML = formatMessage(stoppedText);
            msgEl.dataset.rawText = stoppedText;
            recordMessage("pekacek", stoppedText);
          } else if (event.type === "token") {
            // First token: stop thinking rotation, switch to "reading" mode
            if (!fullText) {
              stopThinkingMessages();
              statusText.textContent = "Odpovídá...";
              statusText.style.color = "#4ecca3";
              setFace("reading", "animate-idle");
            }
            fullText += event.text;
            contentEl.innerHTML = formatMessage(fullText);
            msgEl.dataset.rawText = fullText;
            scrollToBottom();
          } else if (event.type === "tool") {
            // Tool use indicator
            const toolLabels = {
              Read: "čte soubor",
              Grep: "hledá v souborech",
              Glob: "hledá soubory",
              WebFetch: "stahuje stránku",
              WebSearch: "vyhledává",
              Bash: "spouští příkaz",
              ToolSearch: "hledá tooly",
            };
            const label = toolLabels[event.name] || event.name;
            statusText.textContent = `${label}...`;
            statusText.style.color = "#ffd369";
          } else if (event.type === "error") {
            stopThinkingMessages();
            const errText = `Chyba: ${event.error}`;
            contentEl.innerHTML = formatMessage(errText);
            msgEl.dataset.rawText = errText;
            recordMessage("pekacek", errText);
            tempFace("worried", "animate-error");
            statusText.textContent = "Chyba";
            statusText.style.color = "#e94560";
            isWorking = false;
            currentStreamId = null;
            currentAbortCtrl = null;
            hideStopBtn();
            return;
          } else if (event.type === "done") {
            // Finished
          }
        } catch {}
      }
    }

    // Final render
    if (!wasStopped && fullText) {
      contentEl.innerHTML = formatMessage(fullText);
      scrollToBottom();
      recordMessage("pekacek", fullText);
    }

    isWorking = false;
    stopThinkingMessages();
    currentStreamId = null;
    currentAbortCtrl = null;
    hideStopBtn();
    if (wasStopped) {
      tempFace("chill", "animate-idle", 1500);
      statusText.textContent = "Přerušeno";
      statusText.style.color = "#ffd369";
    } else {
      tempFace("happy", "animate-happy", 1500);
      statusText.textContent = "Hotovo";
      statusText.style.color = "#4ecca3";
      // Uživatel se dívá jinam → badge na ikoně
      if (document.hidden) {
        try { chrome.runtime.sendMessage({ type: "response-done" }, () => {}); } catch {}
      }
    }
    setTimeout(() => {
      statusText.textContent = "Připraveny";
      statusText.style.color = "";
    }, 3000);

  } catch (err) {
    isWorking = false;
    stopThinkingMessages();
    currentStreamId = null;
    currentAbortCtrl = null;
    hideStopBtn();
    startIdleLife();

    // AbortError = user clicked Stop — neukazuj error, jen "přerušeno"
    if (err.name === "AbortError") {
      const stoppedText = (fullText || "") + "\n\n_(přerušeno)_";
      contentEl.innerHTML = formatMessage(stoppedText);
      msgEl.dataset.rawText = stoppedText;
      recordMessage("pekacek", stoppedText);
      tempFace("chill", "animate-idle", 1500);
      statusText.textContent = "Přerušeno";
      statusText.style.color = "#ffd369";
      setTimeout(() => {
        statusText.textContent = "Připraveny";
        statusText.style.color = "";
      }, 3000);
      return;
    }

    contentEl.innerHTML = formatMessage(
      err.message.includes("Failed to fetch")
        ? "Bridge není dostupný — spusť ve WSL:\n  node tools/pekacek-extension/bridge.mjs"
        : `Chyba: ${err.message}`
    );
    tempFace("worried", "animate-error");
    statusText.textContent = "Chyba";
    statusText.style.color = "#e94560";
  }
}

// --- Message rendering ---
let messageCounter = 0;

function addMessage(role, content, isLoading = false) {
  const id = `msg-${++messageCounter}`;
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.id = id;

  const contentDiv = document.createElement("div");
  contentDiv.className = "message-content" + (isLoading ? " loading-dots" : "");

  if (isLoading) {
    contentDiv.textContent = "Přemýšlím";
  } else {
    contentDiv.innerHTML = formatMessage(content);
  }

  div.appendChild(contentDiv);

  // Store raw text on the element (for persistence + clipboard). Updated during streaming.
  div.dataset.rawText = isLoading ? "" : content;

  // Copy + Pin buttons for Pekáček messages (not for loading state or user)
  if (role === "pekacek") {

    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    copyBtn.title = "Zkopírovat do schránky";
    copyBtn.textContent = "⧉";
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const text = div.dataset.rawText || "";
      if (!text.trim()) return;
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "✓";
        copyBtn.classList.add("copied");
        setTimeout(() => {
          copyBtn.textContent = "⧉";
          copyBtn.classList.remove("copied");
        }, 1500);
      } catch {
        copyBtn.textContent = "✗";
        setTimeout(() => { copyBtn.textContent = "⧉"; }, 1500);
      }
    });
    div.appendChild(copyBtn);

    const pinBtn = document.createElement("button");
    pinBtn.className = "pin-btn";
    pinBtn.title = "Uložit jako stránku do wiki";
    pinBtn.textContent = "📌";
    pinBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await pinMessageToWiki(div, pinBtn);
    });
    div.appendChild(pinBtn);
  }

  messagesEl.appendChild(div);
  scrollToBottom(role === "user");

  // Persist finalized messages (not streaming placeholders, not during restore)
  if (!isLoading) recordMessage(role, content);

  return id;
}

function removeMessage(id) {
  document.getElementById(id)?.remove();
}

function pinMessageToWiki(msgDiv, btn) {
  const text = msgDiv.dataset.rawText || "";
  if (!text.trim()) return;
  if (btn.disabled || isWorking) return;

  // Mark button as done — pin sent, detail viz v streamu níže
  btn.disabled = true;
  btn.textContent = "✓";
  btn.classList.add("done");
  btn.title = "Pinováno — viz odpověď níže";

  const sourceLine = currentPageContent?.url
    ? `Zdrojový článek: "${currentPageContent.title || ""}" (${currentPageContent.url})`
    : "(Bez zdrojového článku.)";

  const pinPrompt =
    `Uživatel označil tuto odpověď v Pekáček Chrome sidebaru jako hodnotnou a chce ji uložit do wiki jako novou stránku.\n\n` +
    `Postup:\n` +
    `1) Urči nejvhodnější kategorii ve wiki/ (astronomie, cestovani, vzdelavani, myslenky, clanky, technologie, gaming, kultura, nakupy, recepty, lab — nebo jinou existující podsložku).\n` +
    `2) Zvol krátký výstižný název souboru v kebab-case bez diakritiky.\n` +
    `3) Vytvoř stránku podle formátu v CLAUDE.md (Shrnutí, Zdroje, Poslední aktualizace, obsah, [[wiki-links]] pokud relevantní). Nepřepisuj existující — pokud název koliduje, zvol jiný.\n` +
    `4) Aktualizuj wiki/index.md.\n` +
    `5) Zapiš záznam do wiki/log.md (zmiň "pinned z Pekáček sidebaru").\n` +
    `6) Finální řádek odpovědi: \`📌 Uloženo: wiki/<kategorie>/<soubor>.md\`\n\n` +
    `${sourceLine}\n\n` +
    `Obsah k uložení:\n---\n${text}\n---`;

  addMessage("user", "📌 Ulož předchozí odpověď do wiki");
  sendToBridge(pinPrompt, { action: "pin" });
}

function formatMessage(text) {
  return text
    .replace(/```(\w*)\n?([\s\S]*?)```/g, "<pre>$2</pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h3>$1</h3>")
    .replace(/\[\[(.+?)\]\]/g, '<code>[[$1]]</code>')
    .replace(/\n/g, "<br>");
}

// --- Smart scroll ---
// Auto-scroll only if user is near bottom. Otherwise show "new messages" button.
const SCROLL_THRESHOLD = 60; // px from bottom to consider "at bottom"

function isNearBottom() {
  const chat = document.getElementById("chat");
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < SCROLL_THRESHOLD;
}

function scrollToBottom(force = false) {
  const chat = document.getElementById("chat");
  if (force || isNearBottom()) {
    chat.scrollTop = chat.scrollHeight;
    hideNewMessagesButton();
  } else {
    showNewMessagesButton();
  }
}

// "New messages ↓" button
let newMsgBtn = null;

function ensureNewMessagesButton() {
  if (newMsgBtn) return newMsgBtn;
  newMsgBtn = document.createElement("button");
  newMsgBtn.id = "new-messages-btn";
  newMsgBtn.textContent = "↓ Nové zprávy";
  newMsgBtn.style.cssText = `
    position: fixed;
    bottom: 72px;
    left: 50%;
    transform: translateX(-50%) translateY(10px);
    padding: 6px 14px;
    border: 1px solid #4ecca3;
    border-radius: 16px;
    background: #0f3460;
    color: #4ecca3;
    font-size: 12px;
    font-family: "Segoe UI", system-ui, sans-serif;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    opacity: 0;
    transition: opacity 0.2s, transform 0.2s;
    pointer-events: none;
    z-index: 100;
    white-space: nowrap;
  `;
  newMsgBtn.addEventListener("click", () => {
    scrollToBottom(true);
  });
  document.body.appendChild(newMsgBtn);
  return newMsgBtn;
}

function showNewMessagesButton() {
  const btn = ensureNewMessagesButton();
  btn.style.opacity = "1";
  btn.style.transform = "translateX(-50%) translateY(0)";
  btn.style.pointerEvents = "auto";
}

function hideNewMessagesButton() {
  if (!newMsgBtn) return;
  newMsgBtn.style.opacity = "0";
  newMsgBtn.style.transform = "translateX(-50%) translateY(10px)";
  newMsgBtn.style.pointerEvents = "none";
}

// Hide button if user manually scrolls to bottom
document.getElementById("chat").addEventListener("scroll", () => {
  if (isNearBottom()) hideNewMessagesButton();
});

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + "..." : str;
}
