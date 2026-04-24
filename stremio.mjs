#!/usr/bin/env node
/**
 * Stremio Tool — zápis do knihovny přes oficiální JSON API (api.strem.io).
 *
 * CLI:
 *   node stremio.mjs login
 *   node stremio.mjs library-add <tt-id | IMDb URL | ČSFD URL | ČSFD slug>
 *   node stremio.mjs library-mark-watched <...>
 *   node stremio.mjs library-list [--type movie|series] [--unwatched]
 *   node stremio.mjs logout
 *
 * Login: jednorázově přes STREMIO_EMAIL + STREMIO_PASSWORD v .env, výsledný
 * authKey se cachne zpět do .env jako STREMIO_AUTH_KEY (token expiruje až při
 * změně hesla / logoutu).
 *
 * ČSFD mapping cache: ~/pka/.cache/csfd-imdb.json (sdílená napříč voláními).
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(SCRIPT_DIR, '.env');
const CACHE_DIR = path.join(SCRIPT_DIR, '.cache');
const MAPPING_CACHE = path.join(CACHE_DIR, 'csfd-imdb.json');

const API_BASE = 'https://api.strem.io';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// --- API volání ---

async function apiCall(method, body) {
  const res = await fetch(`${API_BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    const msg = data.error.message || JSON.stringify(data.error);
    const err = new Error(`${method}: ${msg}`);
    err.apiCode = data.error.code;
    throw err;
  }
  return data.result;
}

// --- authKey management ---

async function login() {
  const email = process.env.STREMIO_EMAIL;
  const password = process.env.STREMIO_PASSWORD;
  if (!email || !password) throw new Error('STREMIO_EMAIL / STREMIO_PASSWORD chybí v .env');
  const result = await apiCall('login', { type: 'Login', email, password, facebook: false });
  if (!result?.authKey) throw new Error('login: chybí authKey v odpovědi');
  return result.authKey;
}

async function getAuthKey() {
  if (process.env.STREMIO_AUTH_KEY) return process.env.STREMIO_AUTH_KEY;
  const key = await login();
  await saveAuthKey(key);
  process.env.STREMIO_AUTH_KEY = key;
  return key;
}

async function saveAuthKey(key) {
  let env = '';
  try { env = fs.readFileSync(ENV_PATH, 'utf8'); } catch {}
  if (/^STREMIO_AUTH_KEY=/m.test(env)) {
    env = env.replace(/^STREMIO_AUTH_KEY=.*$/m, `STREMIO_AUTH_KEY=${key}`);
  } else {
    if (env && !env.endsWith('\n')) env += '\n';
    env += `STREMIO_AUTH_KEY=${key}\n`;
  }
  fs.writeFileSync(ENV_PATH, env);
}

async function invalidateAuthKey() {
  let env = '';
  try { env = fs.readFileSync(ENV_PATH, 'utf8'); } catch { return; }
  env = env.replace(/^STREMIO_AUTH_KEY=.*\n?/m, '');
  fs.writeFileSync(ENV_PATH, env);
  delete process.env.STREMIO_AUTH_KEY;
}

// Auto-retry když je authKey invalidní.
async function withAuth(fn) {
  try {
    return await fn(await getAuthKey());
  } catch (e) {
    const m = String(e.message || '').toLowerCase();
    if (m.includes('session') || m.includes('authkey') || m.includes('unauth') || e.apiCode === 1) {
      await invalidateAuthKey();
      return await fn(await getAuthKey());
    }
    throw e;
  }
}

// --- ID resolution ---

function isImdbId(s) { return /^tt\d+$/.test(s); }

function extractImdbFromUrl(u) {
  const m = u.match(/\b(tt\d+)\b/);
  return m ? m[1] : null;
}

function loadMappingCache() {
  try { return JSON.parse(fs.readFileSync(MAPPING_CACHE, 'utf8')); } catch { return {}; }
}

function saveMappingCache(c) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(MAPPING_CACHE, JSON.stringify(c, null, 2));
}

// Cinemeta search — Stremio vlastní meta DB, použije ji addon sám.
// Vrací tt-id dle title query + roku, null pokud nenajde match.
async function searchCinemeta(query, year) {
  for (const type of ['movie', 'series']) {
    const u = `${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(query)}.json`;
    const res = await fetch(u, { headers: { 'User-Agent': UA } });
    if (!res.ok) continue;
    const data = await res.json();
    const metas = data?.metas || [];
    for (const m of metas) {
      if (!m.id || !m.id.startsWith('tt')) continue;
      const ri = String(m.releaseInfo || m.year || '');
      const mYear = parseInt(ri.match(/\d{4}/)?.[0] || '0', 10);
      if (!year || !mYear || Math.abs(mYear - year) <= 1) return { imdbId: m.id, type };
    }
  }
  return null;
}

// ČSFD nemá v public HTML IMDb odkaz (propaguje sesterský filmbooster.com se slugem
// anglického titulu). Anubis PoW challenge vyžaduje reálný browser, proto Playwright.
// Z detailu vytáhneme: (1) rok z <title>, (2) anglický title ze slug filmboosteru → Cinemeta search.
async function csfdToImdb(input) {
  let url = input;
  if (!/^https?:\/\//.test(url)) url = `https://www.csfd.cz/film/${url.replace(/^\/+/, '')}/`;
  url = url.split('#')[0].split('?')[0];
  const filmMatch = url.match(/^(https?:\/\/www\.csfd\.cz\/film\/[^/]+)\//);
  if (filmMatch) url = `${filmMatch[1]}/`;

  const cache = loadMappingCache();
  if (cache[url]) return cache[url];

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'cs-CZ', timezoneId: 'Europe/Prague' });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Anubis challenge si vyřeší browser JS sám — stránka pak přepíše <title>.
    await page.waitForFunction(() => !document.title.includes('Making sure'), { timeout: 30000 });
    const title = await page.title();
    const html = await page.content();

    // 1) IMDb link (pro případ že ČSFD někdy vrátí) — nejlevnější
    const direct = html.match(/imdb\.com\/title\/(tt\d+)/);
    if (direct) {
      cache[url] = direct[1];
      saveMappingCache(cache);
      return direct[1];
    }

    // 2) Rok z <title>: "Tajemná řeka (2003) | ČSFD.cz"
    const year = parseInt(title.match(/\((\d{4})\)/)?.[1] || '0', 10) || null;

    // 3) Anglický title z filmbooster.com slugu (EN/CA/UK/AU stránky mají EN slug)
    const fb = html.match(/filmbooster\.(?:com|co\.uk|ca|com\.au)\/film\/\d+-([a-z0-9-]+)\//);
    const enQuery = fb ? fb[1].replace(/-/g, ' ') : null;

    // 4) Fallback query: české jméno z <title>, bez roku
    const czQuery = title.replace(/\s*\(\d{4}\)\s*\|.*$/, '').trim();

    for (const q of [enQuery, czQuery].filter(Boolean)) {
      const hit = await searchCinemeta(q, year);
      if (hit) {
        cache[url] = hit.imdbId;
        saveMappingCache(cache);
        return hit.imdbId;
      }
    }
    throw new Error(`Mapping selhal pro ${url} (year=${year}, en="${enQuery}", cz="${czQuery}") — Cinemeta nevrátila match`);
  } finally {
    await browser.close();
  }
}

async function resolveId(input) {
  if (!input) throw new Error('Chybí argument (tt-id / URL / slug)');
  if (isImdbId(input)) return input;
  if (input.includes('imdb.com')) {
    const id = extractImdbFromUrl(input);
    if (id) return id;
    throw new Error(`IMDb URL neobsahuje tt-id: ${input}`);
  }
  if (input.includes('csfd.cz') || /^\d+(-[\w-]+)?$/.test(input)) {
    return await csfdToImdb(input);
  }
  throw new Error(`Nerozpoznaný tvar: ${input}. Použij tt1234567, IMDb URL, nebo ČSFD URL/slug.`);
}

// --- Cinemeta metadata ---

async function fetchMeta(imdbId) {
  for (const type of ['movie', 'series']) {
    const res = await fetch(`${CINEMETA}/meta/${type}/${imdbId}.json`, { headers: { 'User-Agent': UA } });
    if (!res.ok) continue;
    const data = await res.json();
    if (data?.meta?.name) return { type, meta: data.meta };
  }
  throw new Error(`Cinemeta nemá metadata pro ${imdbId} — nejde dohledat název/poster`);
}

// --- Library ops ---

const nowIso = () => new Date().toISOString();

function blankState() {
  return {
    lastWatched: null,
    timeWatched: 0,
    timeOffset: 0,
    overallTimeWatched: 0,
    timesWatched: 0,
    flaggedWatched: 0,
    duration: 0,
    video_id: null,
    watched: null,
    noNotif: false,
  };
}

function buildItem({ imdbId, type, meta, existing, mutator }) {
  const now = nowIso();
  const item = existing ? JSON.parse(JSON.stringify(existing)) : {
    _id: imdbId,
    name: meta?.name || imdbId,
    type: type || 'movie',
    poster: meta?.poster || '',
    posterShape: meta?.posterShape || 'poster',
    removed: false,
    temp: false,
    _ctime: now,
    _mtime: now,
    state: blankState(),
    behaviorHints: { defaultVideoId: null, hasScheduledVideos: false },
  };
  if (!item.state) item.state = blankState();
  if (mutator) mutator(item);
  item._mtime = now;
  return item;
}

async function datastoreGetOne(authKey, id) {
  const result = await apiCall('datastoreGet', { authKey, collection: 'libraryItem', ids: [id], all: false });
  return result?.[0] || null;
}

async function datastorePut(authKey, changes) {
  return apiCall('datastorePut', { authKey, collection: 'libraryItem', changes });
}

// --- Commands ---

async function cmdLogin() {
  await invalidateAuthKey();
  const key = await login();
  await saveAuthKey(key);
  console.log('✓ Přihlášen. authKey uložen do .env.');
}

async function cmdLogout() {
  await invalidateAuthKey();
  console.log('✓ authKey smazán z .env.');
}

async function cmdLibraryAdd(input) {
  const imdbId = await resolveId(input);
  await withAuth(async (authKey) => {
    const existing = await datastoreGetOne(authKey, imdbId);
    let type, meta;
    if (existing) {
      type = existing.type;
    } else {
      ({ type, meta } = await fetchMeta(imdbId));
    }
    const item = buildItem({
      imdbId, type, meta, existing,
      mutator: (it) => { it.removed = false; it.temp = false; },
    });
    await datastorePut(authKey, [item]);
    const action = existing ? (existing.removed ? 'vráceno do' : 'aktualizováno v') : 'přidáno do';
    console.log(`+ ${imdbId} "${item.name}" (${item.type}) ${action} knihovny`);
  });
}

async function cmdLibraryMarkWatched(input) {
  const imdbId = await resolveId(input);
  await withAuth(async (authKey) => {
    const existing = await datastoreGetOne(authKey, imdbId);
    let type, meta;
    if (existing) {
      type = existing.type;
    } else {
      ({ type, meta } = await fetchMeta(imdbId));
    }
    if (type === 'series') {
      console.log(`⚠  ${imdbId} je seriál — označuju 'flaggedWatched' na úrovni díla, ale bitfield epizod nevyplňuju (to by chtělo read-modify-write přes Stremio core).`);
    }
    const item = buildItem({
      imdbId, type, meta, existing,
      mutator: (it) => {
        it.removed = false;
        it.temp = false;
        it.state.flaggedWatched = 1;
        it.state.timesWatched = Math.max(1, it.state.timesWatched || 0);
        it.state.lastWatched = nowIso();
      },
    });
    await datastorePut(authKey, [item]);
    console.log(`✓ ${imdbId} "${item.name}" označen jako viděný`);
  });
}

async function cmdLibraryList(opts = {}) {
  await withAuth(async (authKey) => {
    const meta = await apiCall('datastoreMeta', { authKey, collection: 'libraryItem' });
    if (!meta?.length) { console.log('(knihovna je prázdná)'); return; }
    const ids = meta.map(([id]) => id);
    const items = await apiCall('datastoreGet', { authKey, collection: 'libraryItem', ids, all: false });
    let list = items.filter((it) => !it.removed);
    if (opts.type) list = list.filter((it) => it.type === opts.type);
    if (opts.unwatched) list = list.filter((it) => !(it.state?.flaggedWatched > 0 || it.state?.timesWatched > 0));
    list.sort((a, b) => String(b._mtime || '').localeCompare(String(a._mtime || '')));
    for (const it of list) {
      const watched = (it.state?.flaggedWatched > 0 || it.state?.timesWatched > 0) ? '✓' : ' ';
      const name = it.name || '?';
      console.log(`${watched} ${it._id.padEnd(12)} [${(it.type || '?').padEnd(6)}] ${name}`);
    }
    console.log(`---\n${list.length} položek${opts.type ? ` typu ${opts.type}` : ''}${opts.unwatched ? ', neviděno' : ''}`);
  });
}

// --- CLI dispatch ---

function usage() {
  console.error(`Stremio CLI — zápis do knihovny přes api.strem.io

Použití:
  node stremio.mjs login
  node stremio.mjs logout
  node stremio.mjs library-add <tt-id | IMDb URL | ČSFD URL | ČSFD slug>
  node stremio.mjs library-mark-watched <tt-id | IMDb URL | ČSFD URL | ČSFD slug>
  node stremio.mjs library-list [--type movie|series] [--unwatched]`);
}

const [, , cmd, ...args] = process.argv;

function parseOpts(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type') opts.type = argv[++i];
    else if (a === '--unwatched') opts.unwatched = true;
  }
  return opts;
}

try {
  switch (cmd) {
    case 'login': await cmdLogin(); break;
    case 'logout': await cmdLogout(); break;
    case 'library-add': await cmdLibraryAdd(args[0]); break;
    case 'library-mark-watched': await cmdLibraryMarkWatched(args[0]); break;
    case 'library-list': await cmdLibraryList(parseOpts(args)); break;
    default: usage(); process.exit(1);
  }
} catch (e) {
  console.error('Chyba:', e.message);
  process.exit(1);
}
