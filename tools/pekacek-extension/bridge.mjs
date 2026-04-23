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
import { fileURLToPath } from "url";

const PORT = 3888;
const CLAUDE_BIN = "claude";
const WORKING_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WIKI_SYMLINK = path.join(WORKING_DIR, "wiki");
const WIKI_TARGET = "/mnt/p/Wiki/Wiki";

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

// --- YouTube transcript (yt-dlp) ---
const TRANSCRIPT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const TRANSCRIPT_TIMEOUT_MS = 45_000;
const transcriptCache = new Map(); // videoId -> { transcript, language, updatedAt }

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

async function fetchYouTubeTranscript(videoId) {
  const cached = transcriptCache.get(videoId);
  if (cached && Date.now() - cached.updatedAt < TRANSCRIPT_TTL_MS) {
    return cached;
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
      proc.on("close", (code) => code === 0 ? resolve() : reject(new Error((stderr || `yt-dlp exit ${code}`).slice(0, 500))));
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
    process.stderr.write(`[bridge] YT transcript ${videoId} (${lang}): ${transcript.length} znaků\n`);
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

  // YouTube transcript via yt-dlp (cached per videoId, TTL 24h)
  if (req.method === "GET" && req.url.startsWith("/youtube/transcript")) {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const videoId = u.searchParams.get("videoId");
    if (!videoId || !/^[A-Za-z0-9_-]{5,15}$/.test(videoId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Missing or invalid videoId" }));
    }
    try {
      const result = await fetchYouTubeTranscript(videoId);
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
        const { prompt, pageUrl, saveArticle, articleTitle } = JSON.parse(body);

        if (!prompt) {
          res.writeHead(400, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Missing prompt" }));
        }

        const reqId = crypto.randomUUID().slice(-8);
        const ts = () => new Date().toISOString().slice(11, 23);
        const log = (msg) => process.stderr.write(`[bridge ${ts()}] [${reqId}] ${msg}\n`);

        // Check if we have an existing session for this page (follow-up)
        const cachedSession = pageUrl && !saveArticle ? articleCache.get(pageUrl) : null;

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
          "--allowedTools", "Bash(node csfd-rate.mjs *) Bash(node tools/*) Bash(grep *) Bash(rg *) Bash(ls *) Bash(find *) mcp__csfd__search mcp__csfd__get_movie mcp__csfd__get_creator mcp__csfd__get_user_ratings",
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
  ║   Pekáček Bridge v2.9.0             ║
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
