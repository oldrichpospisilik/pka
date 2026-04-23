#!/usr/bin/env node
/**
 * ČSFD Tool — hodnocení + watchlist
 *
 * CLI:
 *   node csfd-rate.mjs rate <csfd-url-nebo-id> <hvezdicky-1-5>
 *   node csfd-rate.mjs check <csfd-url-nebo-id>
 *   node csfd-rate.mjs watchlist [--all] [--no-cache]
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

export async function getWatchlist({ allPages = false, noCache = false } = {}) {
  if (!noCache) {
    const cached = readWatchlistCache(allPages);
    if (cached) {
      const films = allPages ? cached.films : cached.films.slice(0, 20); // první stránka = prvních ~20
      return { films, pages: cached.pages, total: films.length, fromCache: true, cachedAt: cached.timestamp };
    }
  }

  const { browser, context, page } = await createSession();

  try {
    const films = [];
    let currentPage = 1;

    while (true) {
      const url = `https://www.csfd.cz/soukrome/chci-videt/?page=${currentPage}&sort=inserted`;
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

      films.push(...pageFilms);

      if (!allPages) break;

      const hasNext = await page.locator('a:has-text("další")').count();
      if (hasNext === 0) break;
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
  console.log(allPages ? 'Načítám celý watchlist...' : 'Načítám první stránku watchlistu...');
  const result = await getWatchlist({ allPages, noCache });
  const age = result.fromCache ? ` (z cache, stáří ${Math.round((Date.now() - result.cachedAt) / 1000)}s)` : '';
  console.log(`\n${result.total} filmů${allPages ? '' : ' (stránka 1)'}${age}:\n`);
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
