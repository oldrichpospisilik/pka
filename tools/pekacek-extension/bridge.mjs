#!/usr/bin/env node
/**
 * Pekacek Bridge — HTTP server ve WSL, propojuje Chrome extension s Claude Code.
 *
 * Spusteni:
 *   node tools/pekacek-extension/bridge.mjs
 *
 * Extension posila POST na localhost:3888/ask, bridge spousti `claude -p`.
 * Claude Code ma pristup ke vsem MCP toolum, wiki, CLAUDE.md — vsechno.
 */

import http from "http";
import { spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "node:crypto";
import { fileURLToPath } from "url";

const PORT = 3888;
const CLAUDE_BIN = "claude";
const WORKING_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WIKI_SYMLINK = path.join(WORKING_DIR, "wiki");
const WIKI_TARGET = "/mnt/p/Wiki/Wiki";

// Načti `~/pka/.env` do process.env (žádný dotenv dep). Pre-existing process.env
// vyhrává — pokud máš GEMINI_API_KEY už exportovaný v shellu, .env se ignoruje.
function loadEnvFile() {
  const envPath = path.join(WORKING_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
    let loaded = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
        loaded++;
      }
    }
    process.stderr.write(`[bridge] .env: loaded ${loaded} keys from ${envPath}\n`);
  } catch (err) {
    process.stderr.write(`[bridge] .env load error: ${err.message}\n`);
  }
}
loadEnvFile();

// Article session cache: pageUrl -> { title, sessionId }
const articleCache = new Map();

// Active /ask requests that can be stopped: reqId -> { proc, res, log }
const activeRequests = new Map();

// Dashboard cache (emails + events from Gmail/Calendar MCP, fetched via Claude)
const DASHBOARD_TTL_MS = 10 * 60 * 1000; // 10 min
const DASHBOARD_TIMEOUT_MS = 90_000;
let dashboardMailCal = null; // { emails, events, updatedAt }
let dashboardPending = false;

function getArticleStats() {
  const dir = path.join(WIKI_TARGET, "clanky");
  if (!fs.existsSync(dir)) return { count: 0, list: [] };

  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "index.md" && f !== "zdroje.md");
    const unread = [];
    for (const file of files) {
      const full = path.join(dir, file);
      let head;
      try { head = fs.readFileSync(full, "utf8").slice(0, 2000); } catch { continue; }
      if (!/^status:\s*chci-precist\b/mi.test(head)) continue;
      const titleMatch = head.match(/^#\s+(.+)$/m) || head.match(/^title:\s*["']?(.+?)["']?\s*$/m);
      unread.push({
        title: titleMatch ? titleMatch[1].trim() : file.replace(/\.md$/, "").replace(/-/g, " "),
        file: `clanky/${file}`,
      });
    }
    return { count: unread.length, list: unread };
  } catch (err) {
    process.stderr.write(`[bridge] getArticleStats error: ${err.message}\n`);
    return { count: 0, list: [], error: err.message };
  }
}

// --- Text-to-Speech (Gemini 3.1 Flash TTS Preview) ---
// API key čteme z process.env.GEMINI_API_KEY (loadEnvFile() ho dotáhne z ~/pka/.env).
// Reference combo (prakticky perfektní CZ): Schedar voice + Empathetic style + Natural pace.
// Defaultní hodnoty viz wiki/lab/gemini-3-1-flash-tts.md.
const TTS_CACHE_DIR = path.join(WORKING_DIR, ".pekacek-tts-cache");
const TTS_CACHE_MAX = 200;            // počet cached WAVů, oldest pruned (~50 MB)
const TTS_TIMEOUT_MS = 30_000;
const TTS_DEFAULT_VOICE = "Schedar";
const TTS_DEFAULT_STYLE = "Empathetic";
const TTS_DEFAULT_PACE = "Natural";
const TTS_MAX_TEXT_LEN = 4000;        // bezpečný cap pro 1 call

if (!fs.existsSync(TTS_CACHE_DIR)) {
  try { fs.mkdirSync(TTS_CACHE_DIR, { recursive: true }); } catch {}
}

function ttsCacheKey(text, voice, style, pace) {
  return crypto.createHash("sha256")
    .update([voice, style, pace, text].join("\n"))
    .digest("hex");
}

function pruneTtsCache() {
  try {
    const files = fs.readdirSync(TTS_CACHE_DIR)
      .filter(f => f.endsWith(".wav"))
      .map(f => ({ f, mtime: fs.statSync(path.join(TTS_CACHE_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    while (files.length > TTS_CACHE_MAX) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(TTS_CACHE_DIR, oldest.f)); } catch {}
    }
  } catch {}
}

// Gemini Flash TTS vrací surové PCM (16-bit signed LE), browser potřebuje WAV.
function wrapPcmAsWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const fileSize = 36 + dataSize;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(fileSize, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataSize, 40);
  return Buffer.concat([h, pcm]);
}

async function callGeminiTTS({ text, voice, style, pace }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY není nastavený. Přidej do ~/pka/.env: GEMINI_API_KEY=AIza… a restartuj bridge.");
  }
  const cleaned = (text || "").trim();
  if (!cleaned) throw new Error("Prázdný text.");
  if (cleaned.length > TTS_MAX_TEXT_LEN) {
    throw new Error(`Text je moc dlouhý (${cleaned.length} znaků, max ${TTS_MAX_TEXT_LEN}).`);
  }

  // Style/pace jdou přes natural-language prefix v textu (Gemini reaguje stejně jako
  // na "Director's note" v AI Studiu).
  const promptText = `[${style}, ${pace} pace] ${cleaned}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }
      }
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini TTS API ${res.status}: ${errBody.slice(0, 300)}`);
  }
  const json = await res.json();
  const inline = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline?.data) {
    throw new Error(`Gemini neresturnoval audio (${JSON.stringify(json).slice(0, 200)}…)`);
  }
  const rateMatch = (inline.mimeType || "").match(/rate=(\d+)/);
  const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
  const pcm = Buffer.from(inline.data, "base64");
  return wrapPcmAsWav(pcm, sampleRate);
}

// --- YouTube transcript (yt-dlp) ---
const TRANSCRIPT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const TRANSCRIPT_TIMEOUT_MS = 45_000;
const TRANSCRIPT_CACHE_FILE = path.join(WORKING_DIR, ".pekacek-transcript-cache.json");
const RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000; // 30 min cooldown after 429
const transcriptCache = new Map(); // videoId -> { transcript, language, updatedAt }
let rateLimitUntil = 0; // epoch ms; skip yt-dlp until past this

// Load persistent cache from disk (survives bridge restarts).
function loadTranscriptCache() {
  try {
    if (!fs.existsSync(TRANSCRIPT_CACHE_FILE)) return;
    const raw = fs.readFileSync(TRANSCRIPT_CACHE_FILE, "utf8");
    const obj = JSON.parse(raw);
    const now = Date.now();
    let loaded = 0, pruned = 0;
    for (const [videoId, entry] of Object.entries(obj)) {
      if (entry && entry.updatedAt && now - entry.updatedAt < TRANSCRIPT_TTL_MS) {
        transcriptCache.set(videoId, entry);
        loaded++;
      } else {
        pruned++;
      }
    }
    process.stderr.write(`[bridge] Transcript cache loaded: ${loaded} entries (${pruned} expired)\n`);
  } catch (err) {
    process.stderr.write(`[bridge] Transcript cache load failed: ${err.message}\n`);
  }
}

// Persist cache to disk (called after each successful fetch).
function saveTranscriptCache() {
  try {
    const obj = Object.fromEntries(transcriptCache);
    fs.writeFileSync(TRANSCRIPT_CACHE_FILE, JSON.stringify(obj), "utf8");
  } catch (err) {
    process.stderr.write(`[bridge] Transcript cache save failed: ${err.message}\n`);
  }
}

loadTranscriptCache();

function parseVTT(raw) {
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("WEBVTT")) continue;
    if (trimmed.startsWith("NOTE ") || trimmed === "NOTE") continue;
    if (/^(Kind|Language):/i.test(trimmed)) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue; // cue numbers
    // Strip inline tags (<c>, <00:00:01.000>, <c.colorXXX>)
    const cleaned = trimmed.replace(/<\/?[^>]+>/g, "").trim();
    if (cleaned) out.push(cleaned);
  }
  // Deduplicate consecutive repeats (YT auto-caps often echo)
  const deduped = [];
  for (const l of out) {
    if (deduped[deduped.length - 1] !== l) deduped.push(l);
  }
  return deduped.join(" ").replace(/\s+/g, " ").trim();
}

async function fetchYouTubeTranscript(videoId, { force = false } = {}) {
  // Cache first (also under rate limit — stale cache is better than nothing)
  if (!force) {
    const cached = transcriptCache.get(videoId);
    if (cached && Date.now() - cached.updatedAt < TRANSCRIPT_TTL_MS) {
      process.stderr.write(`[bridge] YT transcript ${videoId} (cache hit, ${cached.language}, ${cached.transcript.length} znaků)\n`);
      return cached;
    }
  } else {
    transcriptCache.delete(videoId);
    process.stderr.write(`[bridge] YT transcript ${videoId} (force refresh — cache busted)\n`);
  }

  // Bail early if we're in YouTube's rate-limit penalty window.
  if (Date.now() < rateLimitUntil) {
    const mins = Math.ceil((rateLimitUntil - Date.now()) / 60_000);
    throw new Error(
      `YouTube rate limit aktivní (429) — čekám ještě ~${mins} min. Další transcripty nebudou spouštět yt-dlp, aby se to neprodlužovalo.`
    );
  }

  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), `yt-${videoId}-`));
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn("yt-dlp", [
        "--write-auto-sub",
        "--write-sub",
        "--sub-lang", "cs,en",
        "--sub-format", "vtt",
        "--skip-download",
        "--no-warnings",
        "-o", path.join(tmpdir, "%(id)s.%(ext)s"),
        `https://www.youtube.com/watch?v=${videoId}`,
      ], { timeout: TRANSCRIPT_TIMEOUT_MS });

      let stderr = "";
      proc.stderr.on("data", (c) => (stderr += c));
      proc.on("close", (code) => {
        if (code === 0) return resolve();
        // Detect HTTP 429 in yt-dlp stderr and set cooldown
        if (/HTTP Error 429|Too Many Requests/i.test(stderr)) {
          rateLimitUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
          const until = new Date(rateLimitUntil).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
          process.stderr.write(`[bridge] YT rate limit detected — backoff until ${until}\n`);
          return reject(new Error(`YouTube rate limit (HTTP 429). Pozastavuji yt-dlp do ${until}. Zkus později.`));
        }
        reject(new Error((stderr || `yt-dlp exit ${code}`).slice(0, 500)));
      });
      proc.on("error", (err) => reject(new Error(`Nelze spustit yt-dlp: ${err.message}`)));
    });

    const files = fs.readdirSync(tmpdir).filter((f) => f.endsWith(".vtt"));
    if (files.length === 0) throw new Error("Žádný transcript není dostupný pro toto video");

    // Priorita: cs manual > cs auto > en manual > en auto > cokoli
    const priorityOrder = [`${videoId}.cs.vtt`, `${videoId}.en.vtt`];
    const chosen =
      priorityOrder.find((f) => files.includes(f)) ||
      files.find((f) => /\.cs\./.test(f)) ||
      files.find((f) => /\.en\./.test(f)) ||
      files[0];

    const lang = chosen.match(/\.([a-z]{2})(?:[-.][^.]*)?\.vtt$/)?.[1] || "?";
    const raw = fs.readFileSync(path.join(tmpdir, chosen), "utf8");
    const transcript = parseVTT(raw);

    if (!transcript) throw new Error("Transcript je prázdný po parsování VTT");

    const result = {
      transcript,
      language: lang,
      length: transcript.length,
      updatedAt: Date.now(),
    };
    transcriptCache.set(videoId, result);
    saveTranscriptCache();
    process.stderr.write(`[bridge] YT transcript ${videoId} (fresh, ${lang}): ${transcript.length} znaků\n`);
    return result;
  } finally {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {}
  }
}

async function refreshDashboardGmailCal() {
  if (dashboardPending) return;
  dashboardPending = true;
  process.stderr.write(`[bridge] Dashboard: fetching Gmail + Calendar via Claude...\n`);

  const prompt =
    `Potřebuji JSON souhrn pro Pekáček dashboard.\n\n` +
    `1) Přes mcp__claude_ai_Gmail__search_threads najdi nepřečtené emaily (query: "is:unread -category:promotions -category:social", maxResults 10).\n` +
    `2) Přes mcp__claude_ai_Google_Calendar__list_events stáhni události z hlavního Google Calendáře pro následujících 14 dní od dneška.\n\n` +
    `Odpověz POUZE validním JSON, bez markdown fence, bez textu okolo. Přesný tvar:\n` +
    `{\n` +
    `  "emails": [ { "from": "...", "subject": "...", "date": "YYYY-MM-DD" } ],\n` +
    `  "events": [ { "title": "...", "date": "YYYY-MM-DD", "time": "HH:MM nebo null", "daysUntil": 0 } ]\n` +
    `}\n\n` +
    `"daysUntil" = 0 znamená dnes, 1 = zítra atd. Events seřaď chronologicky. "time" dej null pro celodenní události. Pokud nic, vrať prázdné array.`;

  const args = [
    "-p", prompt,
    "--allowedTools", "mcp__claude_ai_Gmail__search_threads mcp__claude_ai_Google_Calendar__list_events",
    "--output-format", "text",
  ];

  try {
    const result = await new Promise((resolve, reject) => {
      const proc = spawn(CLAUDE_BIN, args, {
        cwd: WORKING_DIR,
        env: { ...process.env },
        timeout: DASHBOARD_TIMEOUT_MS,
      });
      let stdout = "", stderr = "";
      proc.stdout.on("data", (c) => (stdout += c));
      proc.stderr.on("data", (c) => (stderr += c));
      proc.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `claude exit ${code}`)));
      proc.on("error", reject);
    });

    const s = result.indexOf("{");
    const e = result.lastIndexOf("}");
    if (s < 0 || e <= s) throw new Error("Žádný JSON v odpovědi");
    const parsed = JSON.parse(result.slice(s, e + 1));

    dashboardMailCal = {
      emails: Array.isArray(parsed.emails) ? parsed.emails : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      updatedAt: Date.now(),
    };
    process.stderr.write(`[bridge] Dashboard: ${dashboardMailCal.emails.length} emails, ${dashboardMailCal.events.length} events\n`);
  } catch (err) {
    process.stderr.write(`[bridge] Dashboard refresh error: ${err.message.slice(0, 200)}\n`);
  } finally {
    dashboardPending = false;
  }
}

function runClaude(prompt, sessionId, isRetry = false, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--output-format", "text"];

    // Continue session if exists (skip on retry — use fresh session)
    if (sessionId && !isRetry) {
      args.push("--session-id", sessionId);
    }

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: WORKING_DIR,
      env: { ...process.env },
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => (stdout += chunk));
    proc.stderr.on("data", (chunk) => (stderr += chunk));

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        // Session locked — retry with fresh session
        if (!isRetry && stderr.includes("already in use")) {
          process.stderr.write(`[bridge] Session locked, retrying with fresh session\n`);
          runClaude(prompt, null, true, timeoutMs).then(resolve).catch(reject);
          return;
        }
        reject(new Error(stderr || `claude exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

const server = http.createServer(async (req, res) => {
  // CORS — allow extension
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Health check
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      status: "running",
      cachedArticles: articleCache.size,
      port: PORT,
    }));
  }

  // Dashboard — returns articles (instant, filesystem) + cached emails/events (refreshed via Claude+MCP every 10 min)
  if (req.method === "GET" && req.url === "/dashboard") {
    const articles = getArticleStats();
    const mc = dashboardMailCal;
    const isFresh = mc && (Date.now() - mc.updatedAt) < DASHBOARD_TTL_MS;

    // Trigger background refresh if stale/missing and not already running
    if (!isFresh && !dashboardPending) {
      refreshDashboardGmailCal();
    }

    const next = mc?.events?.[0] || null;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      articles,
      emails: mc ? { count: mc.emails.length, list: mc.emails } : null,
      events: mc ? { count: mc.events.length, list: mc.events, next } : null,
      pending: !isFresh,
      updatedAt: mc?.updatedAt || null,
    }));
  }

  // Force refresh dashboard (user clicked ↻)
  if (req.method === "POST" && req.url === "/dashboard/refresh") {
    if (!dashboardPending) {
      dashboardMailCal = null; // invalidate cache so GET triggers refresh
      refreshDashboardGmailCal();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, pending: dashboardPending }));
  }

  // YouTube transcript via yt-dlp (cached per videoId, TTL 24h). Pass ?force=1 to bust cache.
  if (req.method === "GET" && req.url.startsWith("/youtube/transcript")) {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const videoId = u.searchParams.get("videoId");
    const force = u.searchParams.get("force") === "1";
    if (!videoId || !/^[A-Za-z0-9_-]{5,15}$/.test(videoId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing or invalid videoId" }));
    }
    try {
      const result = await fetchYouTubeTranscript(videoId, { force });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        videoId,
        transcript: result.transcript,
        language: result.language,
        length: result.length,
      }));
    } catch (err) {
      process.stderr.write(`[bridge] YT transcript ${videoId} error: ${err.message}\n`);
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Forget cached article (on reset)
  if (req.method === "POST" && req.url.startsWith("/forget")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pageUrl = url.searchParams.get("url");
    if (pageUrl) {
      const existed = articleCache.delete(pageUrl);
      process.stderr.write(`[bridge] FORGET ${pageUrl} (${existed ? "removed" : "not cached"})\n`);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Quiz generation — non-streaming JSON. Pekáček quiz Phase 1: 6× ABCD multiple-choice
  // s Bloomovou taxonomií. Vstup: { pageContent, pageUrl, pageTitle }. Výstup: { questions: [...] }.
  if (req.method === "POST" && req.url === "/quiz/generate") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { pageContent, pageUrl, pageTitle } = JSON.parse(body);
        if (!pageContent || pageContent.length < 200) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Stránka nemá dost obsahu (min 200 znaků)." }));
        }

        const reqId = crypto.randomUUID().slice(-8);
        const ts = () => new Date().toISOString().slice(11, 23);
        const log = (msg) => process.stderr.write(`[bridge ${ts()}] [quiz ${reqId}] ${msg}\n`);

        const trimmed = pageContent.length > 18000
          ? pageContent.slice(0, 18000) + "\n\n[…obsah zkrácen]"
          : pageContent;
        const wordCount = trimmed.split(/\s+/).length;

        const prompt =
          `Vytvoř kvíz nad níže uvedenou stránkou. Vrať POUZE validní JSON, žádný text okolo, žádný markdown fence.\n\n` +
          `## Pravidla\n\n` +
          `1. **6 otázek**, narůstající obtížnost podle Bloomovy taxonomie:\n` +
          `   - q1: recall (klíčový fakt z článku)\n` +
          `   - q2: comprehension (porozumění hlavní tezi/argumentu)\n` +
          `   - q3: application (jak by argument fungoval pokud by platilo Z?)\n` +
          `   - q4: analysis (proč autor zvolil X místo Y? co by oslabilo závěr?)\n` +
          `   - q5: synthesis (propojení s obecnějším principem nebo jiným tématem)\n` +
          `   - q6: evaluation (kde je nejslabší místo článku, mezera v důkazech, skok v logice?)\n\n` +
          `2. **Otázky na pochopení a aplikaci, ne na bezvýznamná fakta.** Vyhni se "V kterém roce…", "Kolik příkladů autor zmiňuje…", "Jak se jmenuje X v sekci Y". Tahle fakta jsou nuda a user je do týdne zapomene.\n\n` +
          `3. **Žádné chytáky** — všechny otázky musí jít zodpovědět z článku, ne z externí znalosti.\n\n` +
          `4. **Distraktory musí být pravdě podobné.** Žádné absurdní možnosti. Ideálně: 1 správná + 2 částečně správné/neúplné + 1 dobře znějící, ale v rozporu s článkem.\n\n` +
          `5. **Český jazyk.** Otázka max 2 věty. Každá option max 1 věta.\n\n` +
          `6. **Všech 6 otázek je multiple-choice se 4 možnostmi A/B/C/D.** (Open-ended otázky teď negeneruj — to je další fáze.)\n\n` +
          `## Výstupní JSON schema\n\n` +
          `{\n` +
          `  "questions": [\n` +
          `    {\n` +
          `      "n": 1,\n` +
          `      "bloom": "recall",\n` +
          `      "type": "multiple-choice",\n` +
          `      "question": "...",\n` +
          `      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],\n` +
          `      "correct": "B",\n` +
          `      "rationale": "1-2 věty proč je B správně (zobrazí se uživateli jako feedback)."\n` +
          `    }\n` +
          `  ]\n` +
          `}\n\n` +
          `Pole "bloom" může být: recall, comprehension, application, analysis, synthesis, evaluation. Pole "correct" je písmeno A/B/C/D. "options" jsou přesně 4 řetězce začínající "A) ", "B) ", "C) ", "D) ".\n\n` +
          `## Stránka k testování\n\n` +
          `Název: ${pageTitle || "(bez názvu)"}\n` +
          `URL: ${pageUrl || "(bez URL)"}\n` +
          `Délka: ~${wordCount} slov\n\n` +
          `OBSAH:\n${trimmed}`;

        log(`START title="${(pageTitle || "").slice(0, 50)}" len=${pageContent.length}`);

        const args = [
          "-p", prompt,
          "--output-format", "text",
          "--append-system-prompt",
          "Jsi generátor kvízů pro Pekáček. Vracej POUZE validní JSON podle zadaného schématu, bez jakéhokoliv textu okolo, bez markdown fence. Žádné MCP tooly nepotřebuješ.",
        ];

        const proc = spawn(CLAUDE_BIN, args, {
          cwd: WORKING_DIR,
          env: { ...process.env },
          timeout: 120_000,
        });

        let stdout = "";
        let stderr = "";
        let responded = false;
        const respond = (status, payload) => {
          if (responded) return;
          responded = true;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };

        proc.stdout.on("data", (c) => (stdout += c));
        proc.stderr.on("data", (c) => (stderr += c));
        proc.on("error", (err) => {
          log(`SPAWN ERROR: ${err.message}`);
          respond(500, { error: `spawn: ${err.message}` });
        });
        proc.on("close", (code) => {
          if (code !== 0) {
            log(`EXIT ${code} stderr=${stderr.slice(0, 200)}`);
            return respond(500, { error: stderr.trim() || `claude exit ${code}` });
          }
          const s = stdout.indexOf("{");
          const e = stdout.lastIndexOf("}");
          if (s < 0 || e <= s) {
            log(`PARSE ERROR: žádný JSON v ${stdout.length} znacích`);
            return respond(500, { error: "Claude nevrátil JSON. Zkus to znovu." });
          }
          try {
            const parsed = JSON.parse(stdout.slice(s, e + 1));
            if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
              throw new Error("Žádné otázky v odpovědi");
            }
            // Validate per-question shape
            for (const [i, q] of parsed.questions.entries()) {
              if (!q.question || !Array.isArray(q.options) || q.options.length !== 4 || !q.correct) {
                throw new Error(`Otázka ${i + 1} má neplatný tvar`);
              }
              if (!/^[A-D]$/.test(q.correct)) {
                throw new Error(`Otázka ${i + 1}: correct="${q.correct}" není A-D`);
              }
            }
            log(`OK ${parsed.questions.length} otázek`);
            respond(200, parsed);
          } catch (err) {
            log(`PARSE ERROR: ${err.message}`);
            respond(500, { error: `JSON parse: ${err.message}` });
          }
        });
      } catch (err) {
        process.stderr.write(`[bridge] /quiz/generate error: ${err.message}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  // Text-to-Speech (Gemini Flash TTS) — vrací WAV jako audio/wav
  if (req.method === "POST" && req.url === "/tts") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const text = String(parsed.text || "");
        const voice = String(parsed.voice || TTS_DEFAULT_VOICE);
        const style = String(parsed.style || TTS_DEFAULT_STYLE);
        const pace = String(parsed.pace || TTS_DEFAULT_PACE);
        if (!text.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Prázdný text." }));
        }

        // Cache lookup
        const key = ttsCacheKey(text, voice, style, pace);
        const cachePath = path.join(TTS_CACHE_DIR, `${key}.wav`);
        let wav;
        let fromCache = false;
        if (fs.existsSync(cachePath)) {
          try {
            wav = fs.readFileSync(cachePath);
            fromCache = true;
            // Touch mtime ať pruneTtsCache nezahodí často používané
            try { fs.utimesSync(cachePath, new Date(), new Date()); } catch {}
          } catch {}
        }
        if (!wav) {
          const t0 = Date.now();
          wav = await callGeminiTTS({ text, voice, style, pace });
          const elapsed = Date.now() - t0;
          process.stderr.write(`[bridge] TTS fresh: voice=${voice} text="${text.slice(0, 40).replace(/\n/g, " ")}…" wav=${(wav.length / 1024).toFixed(1)}KB ${elapsed}ms\n`);
          try { fs.writeFileSync(cachePath, wav); } catch {}
          pruneTtsCache();
        } else {
          process.stderr.write(`[bridge] TTS cache: voice=${voice} key=${key.slice(0, 8)}… ${(wav.length / 1024).toFixed(1)}KB\n`);
        }

        res.writeHead(200, {
          "Content-Type": "audio/wav",
          "Content-Length": wav.length,
          "X-Pekacek-Cache": fromCache ? "hit" : "miss",
        });
        res.end(wav);
      } catch (err) {
        process.stderr.write(`[bridge] /tts error: ${err.message}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  // Stop running /ask request
  if (req.method === "POST" && req.url.startsWith("/stop")) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const stopId = url.searchParams.get("id");
    const entry = stopId ? activeRequests.get(stopId) : null;
    if (entry) {
      process.stderr.write(`[bridge] STOP request for ${stopId} — killing PID ${entry.proc.pid}\n`);
      try {
        entry.res.write(`data: ${JSON.stringify({ type: "stopped" })}\n\n`);
      } catch {}
      try { entry.proc.kill("SIGTERM"); } catch {}
      activeRequests.delete(stopId);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, stopped: stopId }));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "No active request with that id" }));
  }

  // Main endpoint — SSE streaming
  if (req.method === "POST" && req.url === "/ask") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { prompt, pageUrl, saveArticle, articleTitle, claudeSessionId } = JSON.parse(body);

        if (!prompt) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Missing prompt" }));
        }

        const reqId = crypto.randomUUID().slice(-8);
        const ts = () => new Date().toISOString().slice(11, 23);
        const log = (msg) => process.stderr.write(`[bridge ${ts()}] [${reqId}] ${msg}\n`);

        // Check if we have an existing session for this page (follow-up)
        // Priority: explicit claudeSessionId from client (persistent history) > articleCache by pageUrl
        const cachedSession = claudeSessionId
          ? { sessionId: claudeSessionId, title: articleTitle || pageUrl || "(restored)" }
          : (pageUrl && !saveArticle ? articleCache.get(pageUrl) : null);

        log(`START prompt=${prompt.slice(0, 80)}...`);

        // SSE headers
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        });

        // System prompt: skip startup checks, answer directly
        const sidebarSystemPrompt =
          "Jsi Pekáček v Chrome sidebar panelu. Uživatel čte článek. " +
          "NEPROVÁDĚJ startup checky (události, emaily, články) — to platí jen pro interaktivní sezení v terminálu. " +
          "Odpověz přímo a stručně. Použij markdown pro strukturu, code bloky pro ASCII diagramy. " +
          "Máš přístup k wiki a MCP toolům, používej je jen když to uživatel explicitně vyžaduje (např. při Wiki/Ingest akci).";

        const args = [
          "-p", prompt,
          "--permission-mode", "acceptEdits",
          "--add-dir", "/mnt/p/Wiki/Wiki",
          "--allowedTools", "Bash(node csfd-rate.mjs *) Bash(node tools/*) Bash(grep *) Bash(rg *) Bash(ls *) Bash(find *) mcp__csfd__search mcp__csfd__get_movie mcp__csfd__get_creator mcp__csfd__get_user_ratings mcp__chrome-bookmarks__list_tabs mcp__chrome-bookmarks__get_active_tab mcp__chrome-bookmarks__screenshot_active_tab mcp__chrome-bookmarks__read_page_text mcp__chrome-bookmarks__read_page_html mcp__chrome-bookmarks__query_selector mcp__chrome-bookmarks__get_form_schema mcp__chrome-bookmarks__list_bookmarks mcp__chrome-bookmarks__search_bookmarks mcp__chrome-bookmarks__find_duplicates",
          "--output-format", "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--append-system-prompt", sidebarSystemPrompt,
        ];

        // Follow-up: resume existing session (Claude remembers the article)
        if (cachedSession) {
          args.push("--resume", cachedSession.sessionId);
          log(`RESUME session ${cachedSession.sessionId.slice(-8)} ("${cachedSession.title}")`);
        } else {
          log(`NEW session`);
        }
        const proc = spawn(CLAUDE_BIN, args, {
          cwd: WORKING_DIR,
          env: { ...process.env },
        });
        log(`PID: ${proc.pid}`);

        // Register as stoppable and inform client of the id
        activeRequests.set(reqId, { proc, res, log });
        res.write(`data: ${JSON.stringify({ type: "session-start", reqId })}\n\n`);

        let hasOutput = false;
        let stderrBuf = "";
        let outputBytes = 0;
        let clientDisconnected = false;
        let lineBuf = "";

        // Track whether we're in a text block (to know when to emit tokens vs thinking)
        let inTextBlock = false;
        let tokenCount = 0;
        let toolInUse = null;

        proc.stdout.on("data", (chunk) => {
          if (clientDisconnected) return;
          lineBuf += chunk.toString();

          const lines = lineBuf.split("\n");
          lineBuf = lines.pop();

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);

              // Capture session_id from init event
              if (event.type === "system" && event.subtype === "init" && event.session_id) {
                // Emit to client for persistent history tracking
                res.write(`data: ${JSON.stringify({ type: "claude-session", sessionId: event.session_id })}\n\n`);
                if (saveArticle && pageUrl) {
                  articleCache.set(pageUrl, {
                    title: articleTitle || pageUrl,
                    sessionId: event.session_id,
                  });
                  log(`CACHED session ${event.session_id.slice(-8)} for "${articleTitle}"`);
                }
              }

              // Stream events — true token-by-token streaming
              if (event.type === "stream_event" && event.event) {
                const ev = event.event;

                // Text block started — start emitting tokens
                if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
                  inTextBlock = true;
                }

                // Text block ended
                if (ev.type === "content_block_stop") {
                  inTextBlock = false;
                }

                // Token delta — stream to client
                if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
                  hasOutput = true;
                  tokenCount++;
                  outputBytes += ev.delta.text.length;
                  res.write(`data: ${JSON.stringify({ type: "token", text: ev.delta.text })}\n\n`);
                  if (tokenCount === 1) log(`FIRST TOKEN: "${ev.delta.text.slice(0, 40).replace(/\n/g, "\\n")}"`);
                }
              }

              // Tool use — notify client
              if (event.type === "assistant" && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === "tool_use" && block.name) {
                    toolInUse = block.name;
                    log(`TOOL: ${block.name}`);
                    res.write(`data: ${JSON.stringify({ type: "tool", name: block.name })}\n\n`);
                  }
                }
              }

              // Final result
              if (event.type === "result") {
                if (!hasOutput && event.result) {
                  res.write(`data: ${JSON.stringify({ type: "token", text: event.result })}\n\n`);
                  hasOutput = true;
                }
                log(`RESULT: ${event.subtype} tokens=${tokenCount} bytes=${outputBytes} duration=${event.duration_ms}ms`);
              }
            } catch (e) {
              // Ignore parse errors (incomplete JSON)
            }
          }
        });

        proc.stderr.on("data", (chunk) => {
          const msg = chunk.toString();
          stderrBuf += msg;
          if (msg.trim()) log(`STDERR: ${msg.trim().slice(0, 200)}`);
        });

        proc.on("close", (code, signal) => {
          log(`CLOSE code=${code} signal=${signal} hasOutput=${hasOutput} outputBytes=${outputBytes}`);
          activeRequests.delete(reqId);
          if (clientDisconnected) return;

          if (code === 0 || (code === null && hasOutput)) {
            res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          } else if (code !== 0 && code !== null) {
            const errMsg = stderrBuf.trim() || `claude exited with code ${code}`;
            log(`ERROR: ${errMsg}`);
            res.write(`data: ${JSON.stringify({ type: "error", error: errMsg })}\n\n`);
          } else {
            // signal === SIGTERM typicky = user Stop; nehlásit jako error
            log(`KILLED signal=${signal}`);
          }
          res.end();
        });

        proc.on("error", (err) => {
          log(`SPAWN ERROR: ${err.message}`);
          activeRequests.delete(reqId);
          if (!clientDisconnected) {
            res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
            res.end();
          }
        });

        // Client disconnect — kill claude process (listen on RESPONSE, not request)
        res.on("close", () => {
          if (!proc.killed) {
            clientDisconnected = true;
            log(`CLIENT DISCONNECTED — killing PID ${proc.pid}`);
            try { proc.kill("SIGTERM"); } catch {}
          }
          activeRequests.delete(reqId);
        });

      } catch (err) {
        process.stderr.write(`[bridge] ERROR: ${err.message}\n`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

function checkEnvironment() {
  const issues = [];
  const ok = [];

  // 1. claude binary accessible
  const claudeCheck = spawnSync(CLAUDE_BIN, ["--version"], { timeout: 3000 });
  if (claudeCheck.error || claudeCheck.status !== 0) {
    issues.push(`✗ 'claude' binary není dostupný (${claudeCheck.error?.message || `exit ${claudeCheck.status}`})`);
  } else {
    ok.push(`✓ claude: ${claudeCheck.stdout.toString().trim()}`);
  }

  // 2. pCloud mount present
  if (!fs.existsSync(WIKI_TARGET)) {
    issues.push(`✗ ${WIKI_TARGET} neexistuje — pCloud asi není namountovaný (spusť 'pcloud' alias)`);
  } else {
    ok.push(`✓ pCloud mount: ${WIKI_TARGET}`);
  }

  // 3. wiki symlink resolves
  try {
    const resolved = fs.realpathSync(WIKI_SYMLINK);
    if (resolved !== WIKI_TARGET) {
      issues.push(`⚠ ${WIKI_SYMLINK} → ${resolved} (čekal jsem ${WIKI_TARGET})`);
    } else {
      ok.push(`✓ symlink ${WIKI_SYMLINK} → ${resolved}`);
    }
  } catch (e) {
    issues.push(`✗ ${WIKI_SYMLINK} symlink nefunguje: ${e.message}`);
  }

  // 4. write access to wiki target
  if (fs.existsSync(WIKI_TARGET)) {
    try {
      fs.accessSync(WIKI_TARGET, fs.constants.R_OK | fs.constants.W_OK);
      ok.push(`✓ wiki read/write OK`);
    } catch (e) {
      issues.push(`✗ wiki není zapisovatelná: ${e.message}`);
    }
  }

  process.stderr.write(`\n[bridge] Startup checks:\n`);
  ok.forEach((line) => process.stderr.write(`[bridge]   ${line}\n`));
  issues.forEach((line) => process.stderr.write(`[bridge]   ${line}\n`));
  if (issues.length) {
    process.stderr.write(`[bridge] ⚠ ${issues.length} problém(ů) — Pin do wiki / ingest nemusí fungovat.\n`);
  }
  process.stderr.write(`\n`);
}

checkEnvironment();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   Pekáček Bridge v2.11.1            ║
  ║   http://localhost:${PORT}/             ║
  ║                                      ║
  ║   ( o_o) ☕  Čekám na extension...   ║
  ║   /|___|\\                            ║
  ║    / \\                               ║
  ╚══════════════════════════════════════╝
  `);
});

// Cleanup old article cache (>4h)
setInterval(() => {
  if (articleCache.size > 20) {
    // Keep only last 10
    const entries = [...articleCache.entries()];
    for (const [url] of entries.slice(0, entries.length - 10)) {
      articleCache.delete(url);
    }
  }
}, 60 * 60 * 1000);
