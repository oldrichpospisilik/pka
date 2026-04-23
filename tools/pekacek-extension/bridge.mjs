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
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const PORT = 3888;
const CLAUDE_BIN = "claude";
const WORKING_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Article session cache: pageUrl -> { title, sessionId }
const articleCache = new Map();

// Active /ask requests that can be stopped: reqId -> { proc, res, log }
const activeRequests = new Map();

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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   Pekáček Bridge v2.1.1             ║
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
