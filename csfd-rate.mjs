#!/usr/bin/env node
/**
 * ČSFD Tool — hodnocení + watchlist
 *
 * CLI:
 *   node csfd-rate.mjs rate <csfd-url-nebo-id> <hvezdicky-1-5>
 *   node csfd-rate.mjs check <csfd-url-nebo-id>
 *   node csfd-rate.mjs watchlist [--all] [--no-cache] [--genre=<id|nazev>[,<id|nazev>...]]
 *     --genre=horor                 — jen horory
 *     --genre=horor,komedie         — průnik (filmy mající oba žánry)
 *     --genre=5                     — alias přes ID
 *   node csfd-rate.mjs watchlist-add <csfd-url-nebo-id> [poznamka]
 *   node csfd-rate.mjs watchlist-remove <csfd-url-nebo-id>
 *   node csfd-rate.mjs logout              (smaže login state + watchlist cache)
 *
 * Cache watchlistu: ~/pka/.csfd-watchlist-cache.json, TTL 10 min (lze přepsat CSFD_CACHE_TTL_SEC env).
 * Watchlist cache se automaticky invaliduje po úspěšném watchlist-add / watchlist-remove.
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { CSFD_USERNAME, CSFD_PASSWORD } = process.env;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(SCRIPT_DIR, '.csfd-state.json');
const WATCHLIST_CACHE = path.join(SCRIPT_DIR, '.csfd-watchlist-cache.json');
const WATCHLIST_TTL_MS = (parseInt(process.env.CSFD_CACHE_TTL_SEC, 10) || 600) * 1000; // default 10 min

// ČSFD genre ID → název (z <select name="genre"> na watchlist stránce)
const GENRE_IDS = {
  'ai-film': 47, 'akcni': 1, 'animovany': 3, 'dobrodruzny': 11, 'dokumentarni': 13,
  'drama': 2, 'eroticky': 45, 'experimentalni': 26, 'fantasy': 4, 'film-noir': 20,
  'historicky': 21, 'horor': 5, 'hudebni': 22, 'imax': 28, 'katastroficky': 39,
  'komedie': 9, 'kratkometrazni': 14, 'krimi': 18, 'loutkovy': 23, 'muzikal': 12,
  'mysteriozni': 16, 'naucny': 44, 'podobenstvi': 25, 'poeticky': 27, 'pohadka': 30,
  'pornograficky': 10, 'povidkovy': 29, 'psychologicky': 31, 'publicisticky': 33,
  'reality-tv': 35, 'road-movie': 40, 'rodinny': 6, 'romanticky': 15, 'sci-fi': 7,
  'soutezni': 36, 'sportovni': 32, 'stand-up': 43, 'talk-show': 34, 'tanecni': 41,
  'telenovela': 38, 'thriller': 8, 'valecny': 17, 'vr-film': 46, 'western': 19,
  'zabavny': 42, 'zivotopisny': 37,
};

// Převede "horor" → 5, "5" → 5. Vrací number nebo null.
function resolveGenre(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, ''); // diakritika → ascii
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return GENRE_IDS[s] ?? null;
}

// --- Helpers ---

function parseFilmUrl(input) {
  if (/^\d+$/.test(input)) {
    return `https://www.csfd.cz/film/${input}/prehled/`;
  }
  let url = input.trim();
  if (!url.endsWith('/')) url += '/';
  if (!url.includes('/prehled/')) {
    url = url.replace(/\/$/, '/prehled/');
  }
  return url;
}

function starsToDataRating(stars) {
  const n = parseInt(stars, 10);
  if (n < 0 || n > 5) throw new Error(`Hodnocení musí být 0–5, dostáno: ${stars}`);
  return n * 20;
}

async function performLogin(page, context) {
  await page.goto('https://www.csfd.cz/', { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Cookie consent — jen když se objeví
  const cookieBtn = page.locator('button:has-text("Rozumím a přijímám")');
  try {
    await cookieBtn.first().waitFor({ state: 'visible', timeout: 3000 });
    await cookieBtn.first().click();
  } catch {
    // Dialog se neobjevil (už přijato, nebo variant bez něj) — OK
  }

  await page.goto('https://www.csfd.cz/prihlaseni/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#frm-loginForm-nick', { timeout: 10000 });
  await page.fill('#frm-loginForm-nick', CSFD_USERNAME);
  await page.fill('#frm-loginForm-password', CSFD_PASSWORD);
  await page.check('#frm-loginForm-permanent');
  await page.click('button[name="send"]');

  // Ověř úspěšný login — čekej na "Odhlásit" v těle stránky (event-based, max 10s)
  try {
    await page.waitForFunction(
      () => document.body && document.body.innerText.includes('Odhlásit'),
      { timeout: 10000 }
    );
  } catch {
    throw new Error('Login na ČSFD selhal — zkontroluj přezdívku a heslo v .env');
  }

  // Ulož state pro příští běhy (přeskočí login)
  await context.storageState({ path: STATE_FILE });
}

async function createSession() {
  if (!CSFD_USERNAME || !CSFD_PASSWORD) {
    throw new Error('Chybí CSFD_USERNAME nebo CSFD_PASSWORD v .env');
  }

  const browser = await chromium.launch({ headless: true });
  const contextOpts = {
    locale: 'cs-CZ',
    timezoneId: 'Europe/Prague',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  const hasState = fs.existsSync(STATE_FILE);
  if (hasState) {
    contextOpts.storageState = STATE_FILE;
  }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  if (!hasState) {
    await performLogin(page, context);
  }

  return { browser, context, page };
}

// Navigate s auth fallback — když nás to přesměruje na /prihlaseni/, re-login a retry.
async function gotoAuth(page, context, url, selectorToWaitFor) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  if (page.url().includes('/prihlaseni')) {
    // Session expired
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
    await performLogin(page, context);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  }
  if (selectorToWaitFor) {
    await page.waitForSelector(selectorToWaitFor, { timeout: 10000 });
  }
}

// --- Rating ---

export async function rateMovie(filmInput, stars) {
  const url = parseFilmUrl(filmInput);
  const dataRating = starsToDataRating(stars);
  const { browser, context, page } = await createSession();

  try {
    await gotoAuth(page, context, url, '.stars-rating, h1');

    const filmTitle = await page.locator('h1').first().textContent();
    const starLink = page.locator(`.stars-rating a[data-rating="${dataRating}"]`);
    if (await starLink.count() === 0) {
      throw new Error(`Hvězdičky nenalezeny na ${url}`);
    }

    await starLink.click();
    // Čekej na success toast NEBO alespoň na dokončení requestu
    try {
      await page.locator('text=úspěšně uloženo').first().waitFor({ timeout: 5000 });
    } catch {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    }

    const pageText = await page.textContent('body');
    const success = pageText.includes('úspěšně uloženo');

    return {
      success,
      film: filmTitle.trim(),
      stars,
      url,
      message: success ? `${filmTitle.trim()} ohodnocen ${stars}★` : 'Hodnocení se možná neuložilo',
    };
  } finally {
    await browser.close();
  }
}

export async function checkRating(filmInput) {
  const url = parseFilmUrl(filmInput);
  const { browser, context, page } = await createSession();

  try {
    await gotoAuth(page, context, url, 'h1');

    const filmTitle = await page.locator('h1').first().textContent();

    let currentRating = null;
    const userRatingStars = await page.$$eval('.current-user-rating .stars', els =>
      els.map(el => el.className)
    );
    for (const cls of userRatingStars) {
      const match = cls.match(/stars-(\d+)/);
      if (match && parseInt(match[1], 10) > 0) {
        currentRating = parseInt(match[1], 10);
        break;
      }
    }

    if (currentRating === null) {
      const activeCount = await page.locator('.my-rating .stars-rating a.active').count();
      if (activeCount > 0) currentRating = activeCount;
    }

    return {
      film: filmTitle.trim(),
      stars: currentRating,
      hasRating: currentRating !== null,
      url,
    };
  } finally {
    await browser.close();
  }
}

// --- Watchlist ---

function readWatchlistCache(allPages) {
  if (!fs.existsSync(WATCHLIST_CACHE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(WATCHLIST_CACHE, 'utf8'));
    const fresh = Date.now() - raw.timestamp < WATCHLIST_TTL_MS;
    const matchesScope = raw.allPages === allPages || raw.allPages === true; // full cache slouží i pro first-page request
    if (fresh && matchesScope) return raw;
  } catch {
    // Poškozený cache soubor, ignoruj
  }
  return null;
}

function writeWatchlistCache(result, allPages) {
  try {
    fs.writeFileSync(
      WATCHLIST_CACHE,
      JSON.stringify({ timestamp: Date.now(), allPages, ...result }, null, 2)
    );
  } catch {
    // Cache zápis selhal — neblokovat
  }
}

function invalidateWatchlistCache() {
  if (fs.existsSync(WATCHLIST_CACHE)) fs.unlinkSync(WATCHLIST_CACHE);
}

async function fetchWatchlistPage(page, context, { genre, pageNum }) {
  const params = new URLSearchParams({ sort: 'inserted' });
  if (genre) params.set('genre', String(genre));
  if (pageNum > 1) params.set('page', String(pageNum));
  const url = `https://www.csfd.cz/soukrome/chci-videt/?${params.toString()}`;
  await gotoAuth(page, context, url, '.film-title-nooverflow, .box-empty, .content');

  const pageFilms = await page.$$eval('.film-title-nooverflow', els =>
    els.map(el => {
      const link = el.querySelector('a');
      if (!link) return null;
      const href = link.getAttribute('href');
      const match = href?.match(/\/film\/(\d+)-/);
      return {
        title: link.textContent?.trim(),
        href,
        csfdId: match ? parseInt(match[1], 10) : null,
      };
    }).filter(Boolean)
  );

  const hasNext = await page.locator('.box-more-bar a.page-next').count();
  return { films: pageFilms, hasNext: hasNext > 0 };
}

async function fetchGenreFilms(page, context, genre) {
  const films = [];
  const MAX_PAGES = 50;
  for (let p = 1; p <= MAX_PAGES; p++) {
    const { films: pageFilms, hasNext } = await fetchWatchlistPage(page, context, { genre, pageNum: p });
    films.push(...pageFilms);
    if (!hasNext) break;
  }
  return films;
}

// Multi-genre filter = průnik (ČSFD URL neumí kombinovat žánry, proto fetch per žánr + intersect).
export async function getWatchlist({ allPages = false, noCache = false, genres = [] } = {}) {
  // Cache používáme jen pro unfiltered fetch — filtry jsou ad-hoc.
  if (!genres.length && !noCache) {
    const cached = readWatchlistCache(allPages);
    if (cached) {
      const films = allPages ? cached.films : cached.films.slice(0, 20);
      return { films, pages: cached.pages, total: films.length, fromCache: true, cachedAt: cached.timestamp };
    }
  }

  const { browser, context, page } = await createSession();

  try {
    // Multi-genre → průnik. Single genre → stáhni všechny stránky daného žánru.
    if (genres.length > 0) {
      const perGenre = [];
      for (const g of genres) {
        perGenre.push(await fetchGenreFilms(page, context, g));
      }
      const idSets = perGenre.map(arr => new Set(arr.map(f => f.csfdId)));
      const films = perGenre[0].filter(f => idSets.every(s => s.has(f.csfdId)));
      return { films, pages: null, total: films.length, genres };
    }

    // Unfiltered (původní chování).
    const films = [];
    let currentPage = 1;
    const MAX_PAGES = 50;
    while (currentPage <= MAX_PAGES) {
      const { films: pageFilms, hasNext } = await fetchWatchlistPage(page, context, { pageNum: currentPage });
      films.push(...pageFilms);
      if (!allPages || !hasNext) break;
      currentPage++;
    }

    const result = { films, pages: currentPage, total: films.length };
    writeWatchlistCache(result, allPages);
    return result;
  } finally {
    await browser.close();
  }
}

export async function watchlistAdd(filmInput, note = '') {
  const url = parseFilmUrl(filmInput);
  const { browser, context, page } = await createSession();

  try {
    await gotoAuth(page, context, url, 'a.btn-profile-action, h1');

    const filmTitle = await page.locator('h1').first().textContent();

    const wantSeeBtn = page.locator('a.btn-profile-action:has-text("Chci vidět")');
    if (await wantSeeBtn.count() === 0) {
      throw new Error(`Tlačítko "Chci vidět" nenalezeno na ${url}`);
    }
    await wantSeeBtn.click();
    await page.waitForSelector('#watchlistForm', { timeout: 5000 });

    const removeAfterRating = page.locator('#frm-watchlistForm-watchlistForm-remove_after_rating');
    if (await removeAfterRating.count() > 0) {
      await removeAfterRating.check();
    }

    if (note) {
      await page.fill('#frm-watchlistForm-watchlistForm-note', note);
    }

    await page.click('#watchlistForm button[name="ok"]');
    await page.locator('text=úspěšně, text=Odebrat z Chci vidět').first().waitFor({ timeout: 5000 }).catch(() => {});

    const pageText = await page.textContent('body');
    const success = pageText.includes('úspěšně') || pageText.includes('Odebrat z Chci vidět');
    if (success) invalidateWatchlistCache();

    return {
      success,
      film: filmTitle.trim(),
      url,
      message: success ? `${filmTitle.trim()} přidán do Chci vidět` : 'Přidání se možná nepovedlo',
    };
  } finally {
    await browser.close();
  }
}

export async function watchlistRemove(filmInput) {
  const url = parseFilmUrl(filmInput);
  const { browser, context, page } = await createSession();

  try {
    await gotoAuth(page, context, url, 'a.btn-profile-action, h1');

    const filmTitle = await page.locator('h1').first().textContent();

    const wantSeeBtn = page.locator('a.btn-profile-action:has-text("Chci vidět")');
    if (await wantSeeBtn.count() === 0) {
      throw new Error(`Tlačítko "Chci vidět" nenalezeno na ${url}`);
    }
    await wantSeeBtn.click();
    await page.waitForSelector('#watchlistForm, button:has-text("Odebrat")', { timeout: 5000 });

    const removeBtn = page.locator('button:has-text("Odebrat"), button:has-text("odebrat"), #frm-watchlistForm-remove-form button[type="submit"]');
    if (await removeBtn.count() > 0) {
      await removeBtn.first().click();
    } else {
      await page.locator('#frm-watchlistForm-remove-form').evaluate(form => form.submit());
    }
    await page.locator('text=úspěšně, text=Přidat do Chci vidět').first().waitFor({ timeout: 5000 }).catch(() => {});

    const pageText = await page.textContent('body');
    const success = pageText.includes('úspěšně') || pageText.includes('Přidat do Chci vidět');
    if (success) invalidateWatchlistCache();

    return {
      success,
      film: filmTitle.trim(),
      url,
      message: success ? `${filmTitle.trim()} odebrán z Chci vidět` : 'Odebrání se možná nepovedlo',
    };
  } finally {
    await browser.close();
  }
}

// --- CLI ---

const [,, command, ...args] = process.argv;

if (command === 'rate') {
  const [filmInput, stars] = args;
  if (!filmInput || !stars) {
    console.error('Použití: node csfd-rate.mjs rate <url-nebo-id> <1-5>');
    process.exit(1);
  }
  console.log(`Hodnotím ${filmInput} na ${stars}★...`);
  const result = await rateMovie(filmInput, parseInt(stars, 10));
  console.log(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);

} else if (command === 'check') {
  const [filmInput] = args;
  if (!filmInput) {
    console.error('Použití: node csfd-rate.mjs check <url-nebo-id>');
    process.exit(1);
  }
  const result = await checkRating(filmInput);
  console.log(result.stars ? `${result.film}: ${result.stars}★` : `${result.film}: nehodnoceno`);

} else if (command === 'watchlist') {
  const allPages = args.includes('--all');
  const noCache = args.includes('--no-cache');
  // --genre=horor nebo --genre=5 nebo --genre=horor,komedie (průnik)
  const genreArg = args.find(a => a.startsWith('--genre='))?.slice('--genre='.length);
  const genres = genreArg
    ? genreArg.split(',').map(s => resolveGenre(s)).filter(g => g != null)
    : [];
  const invalidGenres = genreArg ? genreArg.split(',').filter(s => resolveGenre(s) == null) : [];
  if (invalidGenres.length) {
    console.error(`Neznámé žánry: ${invalidGenres.join(', ')}. Zkus číselné ID nebo např. horor, komedie, sci-fi, thriller, ...`);
    process.exit(1);
  }

  if (genres.length) {
    console.log(`Načítám watchlist s filtrem žánrů: ${genreArg}...`);
  } else {
    console.log(allPages ? 'Načítám celý watchlist...' : 'Načítám první stránku watchlistu...');
  }
  const result = await getWatchlist({ allPages, noCache, genres });
  const age = result.fromCache ? ` (z cache, stáří ${Math.round((Date.now() - result.cachedAt) / 1000)}s)` : '';
  const scopeNote = genres.length
    ? (genres.length === 1 ? ` (žánr ${genreArg})` : ` (průnik ${genres.length} žánrů: ${genreArg})`)
    : (allPages ? '' : ' (stránka 1)');
  console.log(`\n${result.total} filmů${scopeNote}${age}:\n`);
  for (const film of result.films) {
    console.log(`  ${film.title}  https://www.csfd.cz${film.href}`);
  }

} else if (command === 'watchlist-add') {
  const [filmInput, ...noteParts] = args;
  if (!filmInput) {
    console.error('Použití: node csfd-rate.mjs watchlist-add <url-nebo-id> [poznamka]');
    process.exit(1);
  }
  const note = noteParts.join(' ');
  console.log(`Přidávám do Chci vidět...`);
  const result = await watchlistAdd(filmInput, note);
  console.log(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);

} else if (command === 'watchlist-remove') {
  const [filmInput] = args;
  if (!filmInput) {
    console.error('Použití: node csfd-rate.mjs watchlist-remove <url-nebo-id>');
    process.exit(1);
  }
  console.log(`Odebírám z Chci vidět...`);
  const result = await watchlistRemove(filmInput);
  console.log(result.success ? `✓ ${result.message}` : `✗ ${result.message}`);

} else if (command === 'logout') {
  let deleted = 0;
  if (fs.existsSync(STATE_FILE)) { fs.unlinkSync(STATE_FILE); deleted++; }
  if (fs.existsSync(WATCHLIST_CACHE)) { fs.unlinkSync(WATCHLIST_CACHE); deleted++; }
  console.log(deleted ? `✓ Smazáno ${deleted} soubor(ů) (state + cache)` : 'Nic k smazání');
  process.exit(0);

} else if (command) {
  console.error(`Neznámý příkaz: ${command}\nPříkazy: rate, check, watchlist, watchlist-add, watchlist-remove, logout`);
  process.exit(1);
}
