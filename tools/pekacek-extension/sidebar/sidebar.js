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

// --- DOM ---
const face = document.getElementById("pekacek-face");
const statusText = document.getElementById("status-text");
const pageIndicator = document.getElementById("page-indicator");
const messagesEl = document.getElementById("messages");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");

// --- Init ---
checkBridgeStatus();
setFace("wave", "animate-wave");
setTimeout(() => {
  setFace("idle", "animate-idle");
  startIdleLife();
}, 2000);

// Get tab info and offer to read (no content script needed)
setTimeout(() => loadTabInfo(), 500);

// --- Bridge status ---
function checkBridgeStatus() {
  chrome.runtime.sendMessage({ type: "check-bridge" }, (res) => {
    if (res?.status === "running") {
      statusText.textContent = "Claude Code pripojen";
      statusText.style.color = "#4ecca3";
    } else {
      statusText.textContent = "Bridge offline";
      statusText.style.color = "#e94560";
      addMessage("pekacek",
        "Bridge neni dostupny. Spust ve WSL:\n\n" +
        "  node tools/pekacek-extension/bridge.mjs\n\n" +
        "Pak me refreshni (F5 v sidebaru)."
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
function loadTabInfo() {
  chrome.runtime.sendMessage({ type: "get-tab-info" }, (res) => {
    if (res && !res.error) {
      pageIndicator.textContent = truncate(res.title, 35);

      // New page? Offer to read
      if (!articleRead && res.url !== lastReadUrl) {
        const skipPatterns = ["google.com/search", "youtube.com", "github.com", "localhost", "chrome://", "chrome-extension://", "about:"];
        if (!skipPatterns.some(p => res.url.includes(p))) {
          offerToRead(res.title, res.url);
        }
      }
    } else {
      pageIndicator.textContent = "—";
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
        resolve(null);
      }
    });
  });
}

// Offer Pekáček to read the article (just from title+URL, no content script)
function offerToRead(title, url) {
  const msgId = addMessage("pekacek",
    `Vidim clanek: **${truncate(title, 50)}**\n\n` +
    `Mam si ho precist? Pak budu rychlejsi s dalsima akcema.`
  );

  const msgEl = document.getElementById(msgId);
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "margin-top: 8px; display: flex; gap: 6px;";

  const readBtn = document.createElement("button");
  readBtn.textContent = "Precti si ho";
  readBtn.style.cssText = "padding: 5px 12px; border: 1px solid var(--green); border-radius: 5px; background: rgba(78,204,163,0.15); color: var(--green); font-size: 12px; cursor: pointer;";
  readBtn.addEventListener("click", () => {
    btnRow.remove();
    readArticle(title, url);
  });

  const skipBtn = document.createElement("button");
  skipBtn.textContent = "Preskoc";
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
  addMessage("user", "Precti si ten clanek");

  // Now extract content (content script runs here)
  const page = await extractPageContent();
  if (!page) {
    addMessage("pekacek", "Nepodarilo se precist obsah stranky. Zkus refreshnout stranku a znovu otevrit sidebar.");
    tempFace("worried", "animate-error");
    return;
  }

  const prompt =
    `Uzivatel je na strance "${title}" (${url}). ` +
    `Precti si clanek a zapamatuj si ho — budou nasledovat dalsi otazky. ` +
    `Ted mi dej svuj nazor na 3-4 vety: co je hlavni myslenka, co te zaujalo, ` +
    `a jestli s necim nesouhlasis nebo ti neco chybi.\n\n` +
    `Obsah clanku:\n${page.text}`;

  await sendToBridge(prompt, { saveArticle: true, articleTitle: title });

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
  }
});

// --- Actions ---
document.getElementById("actions").addEventListener("click", (e) => {
  const btn = e.target.closest(".action-btn");
  if (!btn) return;

  const action = btn.dataset.action;
  if (action === "save") return handleSave();
  if (action === "ingest") return handleIngest();

  // Ensure we have page content (extract if needed)
  ensurePageContent().then((content) => {
    if (!content) {
      addMessage("pekacek", "Nepodarilo se precist stranku. Zkus refreshnout a znovu.");
      tempFace("worried", "animate-error");
      return;
    }

    const text = currentPageContent.selection || currentPageContent.text;
    const pageCtx = `Stranka: "${currentPageContent.title}"\nURL: ${currentPageContent.url}\n`;

    // If article already read into session, use short prompts (no full text resend)
    const hasContext = articleRead && currentPageContent.url === lastReadUrl;
    const ctxNote = hasContext
      ? `(Clanek uz mas precteny v teto session — nepotrebujes ho znovu.)\n`
      : `${pageCtx}\nObsah:\n${text}`;

    const prompts = {
      summarize: hasContext
        ? `Shrn clanek co uz mas precteny — klicoce myslenky, co je nove/zajimave. Pokud to souvisi s wiki, zmin to.`
        : `Uzivatel cte clanek v Chrome sidebar panelu. Shrn ho strucne — klicoce myslenky, co je nove/zajimave. Pokud to souvisi s necim ve wiki, zmin to.\n\n${pageCtx}\nObsah:\n${text}`,
      counter: hasContext
        ? `K tomu clanku co uz znas — najdi slabiny, protimyslenky a neoverena tvrzeni. Bud konstruktivne kriticky.`
        : `Uzivatel cte clanek. Najdi slabiny, protimyslenky a neoverena tvrzeni. Bud konstruktivne kriticky.\n\n${pageCtx}\nObsah:\n${text}`,
      experiment: hasContext
        ? `K tomu clanku — navrhni 2-3 prakticke experimenty nebo zpusoby jak overit tvrzeni. Neco co muze realne zkusit.`
        : `Uzivatel cte clanek. Navrhni 2-3 prakticke experimenty nebo zpusoby jak overit tvrzeni. Neco co muze realne zkusit.\n\n${pageCtx}\nObsah:\n${text}`,
      analogy: hasContext
        ? `K tomu clanku — vysvetli hlavni koncepty pomoci ANALOGII z bezneho zivota. "Je to jako kdyz..." Pro kazdy klicocy koncept. Analogie z vareni, sportu, staveni domu, cestovani. Presne, ne jen hezke.`
        : `Uzivatel cte clanek a chce ho lepe pochopit. Vysvetli hlavni koncepty pomoci ANALOGII z bezneho zivota. Pro kazdy klicocy koncept najdi prirovnani ktere ho zpristupni ("je to jako kdyz..."). Pouzij analogie z vareni, sportu, staveni domu, cestovani — cokoli intuitivniho. Nezjednodusuj az moc — analogie ma byt presna, ne jen hezka.\n\n${pageCtx}\nObsah:\n${text}`,
      diagram: hasContext
        ? `K tomu clanku — nakresli ASCII diagramy hlavnich konceptu: flowcharty, hierarchie, casove osy, srovnavaci tabulky, relacni mapy. Vice diagramu pokud pokryva vic temat. Ke kazdemu 1-2 vety vysvetleni. Code bloky.`
        : `Uzivatel cte clanek a chce VIZUALIZACI hlavnich konceptu. Nakresli ASCII diagramy: flowcharty (sipky →, ↓, boxes [ ]), hierarchie (stromecky), casove osy, srovnavaci tabulky, nebo relacni mapy. Pouzij vice diagramu pokud clanek pokryva vic temat. Ke kazdemu diagramu pridej 1-2 vety vysvetleni. Formatuj diagramy v code blocich.\n\n${pageCtx}\nObsah:\n${text}`,
      eli5: hasContext
        ? `K tomu clanku — vysvetli to jako petilétemu diteti. Kratke vety, zadny odborny jazyk, konkretni priklady z detskeho sveta. Ale zachovej jadro myslenky.`
        : `Uzivatel cte clanek a chce uplne jednoduche vysvetleni. Vysvetli to jako bys to vysvetloval zvedavemu petilétemu diteti — kratke vety, zadny odborny jazyk, konkretni priklady z detskeho sveta. Ale zachovej jadro myslenky — ELI5 neznamena nepresny.\n\n${pageCtx}\nObsah:\n${text}`,
      wiki: hasContext
        ? `K tomu clanku — kam by patril v nasi wiki? Navrhni kategorii, nazev stranky, propojeni s existujicimi tematy. Mas pristup k wiki — podivej se co uz tam je.`
        : `Uzivatel cte clanek. Kam by patril v nasi wiki? Navrhni kategorii, nazev stranky, propojeni s existujicimi tematy. Mas pristup k wiki — podivej se co uz tam je.\n\n${pageCtx}\nObsah:\n${text}`,
    };

    const userMsg = prompts[action];
    if (!userMsg) return;

    const labels = {
      summarize: "Shrn tuhle stranku",
      counter: "Najdi slabiny a protimyslenky",
      experiment: "Navrhni experimenty k overeni",
      analogy: "Vysvetli pomoci analogii",
      diagram: "Nakresli diagram konceptu",
      eli5: "Vysvetli jako patiletemu",
      wiki: "Kam to patri ve wiki?",
    };
    addMessage("user", labels[action]);
    sendToBridge(userMsg);
  });
});

// --- Save to _raw ---
async function handleSave() {
  if (!currentPageContent) await ensurePageContent();
  if (!currentPageContent) {
    addMessage("pekacek", "Neni co ulozit — otevri stranku.");
    return;
  }

  chrome.runtime.sendMessage(
    { type: "save-to-raw", url: currentPageContent.url, title: currentPageContent.title },
    (res) => {
      if (res?.success) {
        addMessage("pekacek", `Ulozeno do _raw: "${truncate(currentPageContent.title, 40)}"`);
        tempFace("dancing", "animate-dance", 2500);
      } else {
        addMessage("pekacek", `Chyba: ${res?.error || "neznama"}`);
        tempFace("worried", "animate-error");
      }
    }
  );
}

// --- Direct ingest ---
async function handleIngest() {
  if (!currentPageContent) await ensurePageContent();
  if (!currentPageContent) {
    addMessage("pekacek", "Neni co ingestovat — otevri stranku.");
    return;
  }

  addMessage("user", "Ingestuj tuhle stranku do wiki");

  const prompt =
    `Uzivatel chce ingestovat tuto stranku do wiki. Zpracuj ji podle ingest workflow v CLAUDE.md — ` +
    `urcil kategorii, vytvor wiki stranku, propoj s existujicimi strankami, aktualizuj index.md a log.md.\n\n` +
    `Stranka: "${currentPageContent.title}"\nURL: ${currentPageContent.url}\n\nObsah:\n${currentPageContent.text}`;

  sendToBridge(prompt);
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
      `Kontext stranky (uzivatel ji cte v Chrome): "${currentPageContent.title}" (${currentPageContent.url})\n` +
      `Text: ${pageText.slice(0, 8000)}\n\n---\nDotaz uzivatele: ${text}`;
  }

  sendToBridge(fullMsg);
}

// --- Bridge communication (SSE streaming) ---
const BRIDGE_URL = "http://localhost:3888";

async function sendToBridge(prompt, extra = {}) {
  isWorking = true;
  stopIdleLife();
  setFace("thinking", "animate-thinking");
  statusText.textContent = "Claude premysli...";
  statusText.style.color = "#ffd369";

  // Create empty message that we'll fill with streamed tokens
  const msgId = addMessage("pekacek", "", true);
  const msgEl = document.getElementById(msgId);
  const contentEl = msgEl.querySelector(".message-content");
  contentEl.className = "message-content"; // remove loading-dots
  let fullText = "";

  try {
    const response = await fetch(`${BRIDGE_URL}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        pageUrl: currentPageContent?.url || null,
        ...extra,
      }),
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

          if (event.type === "token") {
            fullText += event.text;
            contentEl.innerHTML = formatMessage(fullText);
            scrollToBottom();
            // Switch to reading face after first tokens
            if (fullText.length < 50) setFace("reading", "animate-idle");
          } else if (event.type === "tool") {
            // Tool use indicator
            const toolLabels = {
              Read: "cte soubor",
              Grep: "hleda v souborech",
              Glob: "hleda soubory",
              WebFetch: "stahuje stranku",
              WebSearch: "vyhledava",
              Bash: "spousti prikaz",
              ToolSearch: "hleda tooly",
            };
            const label = toolLabels[event.name] || event.name;
            statusText.textContent = `${label}...`;
            statusText.style.color = "#ffd369";
          } else if (event.type === "error") {
            contentEl.innerHTML = formatMessage(`Chyba: ${event.error}`);
            tempFace("worried", "animate-error");
            statusText.textContent = "Chyba";
            statusText.style.color = "#e94560";
            return;
          } else if (event.type === "done") {
            // Finished
          }
        } catch {}
      }
    }

    // Final render
    if (fullText) {
      contentEl.innerHTML = formatMessage(fullText);
      scrollToBottom();
    }

    isWorking = false;
    tempFace("happy", "animate-happy", 1500);
    statusText.textContent = "Hotovo";
    statusText.style.color = "#4ecca3";
    setTimeout(() => {
      statusText.textContent = "Pripraveny";
      statusText.style.color = "";
    }, 3000);

  } catch (err) {
    isWorking = false;
    startIdleLife();
    contentEl.innerHTML = formatMessage(
      err.message.includes("Failed to fetch")
        ? "Bridge neni dostupny — spust ve WSL:\n  node tools/pekacek-extension/bridge.mjs"
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
    contentDiv.textContent = "Premyslim";
  } else {
    contentDiv.innerHTML = formatMessage(content);
  }

  div.appendChild(contentDiv);
  messagesEl.appendChild(div);
  scrollToBottom();
  return id;
}

function removeMessage(id) {
  document.getElementById(id)?.remove();
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

function scrollToBottom() {
  const chat = document.getElementById("chat");
  chat.scrollTop = chat.scrollHeight;
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + "..." : str;
}
