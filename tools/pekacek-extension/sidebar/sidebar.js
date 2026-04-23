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

// --- State ---
let currentPageContent = null;
let articleRead = false;   // true after Pekáček read the article into session
let lastReadUrl = null;    // URL of the article in session
let currentStreamId = null; // reqId of in-flight /ask request (for Stop)
let currentAbortCtrl = null; // AbortController pro aktuální stream

// --- DOM ---
const face = document.getElementById("pekacek-face");
const statusText = document.getElementById("status-text");
const pageIndicator = document.getElementById("page-indicator");
const messagesEl = document.getElementById("messages");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");

// --- Init ---
checkBridgeStatus();
setFace("wave", "animate-wave");
setTimeout(() => {
  setFace("idle", "animate-idle");
  startIdleLife();
}, 2000);

// Clear any pending badge — user is looking at the sidebar now
try { chrome.runtime.sendMessage({ type: "clear-badge" }, () => {}); } catch {}

// Get tab info and offer to read (no content script needed)
setTimeout(() => loadTabInfo(), 500);

// Reset button
document.getElementById("reset-btn").addEventListener("click", () => {
  resetChat();
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

  // Clear messages
  messagesEl.innerHTML = "";
  messageCounter = 0;

  // Forget article state
  articleRead = false;
  lastReadUrl = null;
  currentPageContent = null;

  hideNewMessagesButton();
  statusText.textContent = "Pripraveny";
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

    // Offer to read
    if (!articleRead && url && url !== lastReadUrl) {
      const skipPatterns = [
        "google.com/search",
        "chrome://",
        "chrome-extension://",
        "about:",
        "newtab",
      ];
      if (!skipPatterns.some((p) => url.includes(p))) {
        offerToRead(title || "tato stránka", url);
      }
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

// --- Dropdown toggles ---
function closeAllDropdowns() {
  document.querySelectorAll(".dropdown-menu.open").forEach((m) => m.classList.remove("open"));
  document.querySelectorAll(".dropdown-toggle.open").forEach((t) => t.classList.remove("open"));
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".action-dropdown")) closeAllDropdowns();
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
const BRIDGE_URL = "http://localhost:3888";

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
          } else if (event.type === "stopped") {
            wasStopped = true;
            const stoppedText = (fullText || "") + "\n\n_(přerušeno)_";
            contentEl.innerHTML = formatMessage(stoppedText);
            msgEl.dataset.rawText = stoppedText;
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

  // Copy + Pin buttons for Pekáček messages (not for loading state or user)
  if (role === "pekacek") {
    // Store raw text for clipboard (updated during streaming)
    div.dataset.rawText = isLoading ? "" : content;

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
