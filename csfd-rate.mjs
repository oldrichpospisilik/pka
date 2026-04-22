#!/usr/bin/env node
/**
 * ČSFD Tool — hodnocení + watchlist
 *
 * CLI:
 *   node csfd-rate.mjs rate <csfd-url-nebo-id> <hvezdicky-1-5>
 *   node csfd-rate.mjs check <csfd-url-nebo-id>
 *   node csfd-rate.mjs watchlist [--all]
 *   node csfd-rate.mjs watchlist-add <csfd-url-nebo-id> [poznamka]
 *   node csfd-rate.mjs watchlist-remove <csfd-url-nebo-id>
 */

import 'dotenv/config';
import { firefox } from 'playwright';

const { CSFD_USERNAME, CSFD_PASSWORD } = process.env;

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

async function createSession() {
  if (!CSFD_USERNAME || !CSFD_PASSWORD) {
    throw new Error('Chybí CSFD_USERNAME nebo CSFD_PASSWORD v .env');
  }

  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ locale: 'cs-CZ', timezoneId: 'Europe/Prague' });
  const page = await context.newPage();

  // Cookie consent
  await page.goto('https://www.csfd.cz/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  const cookieBtn = page.locator('button:has-text("Rozumím a přijímám")');
  if (await cookieBtn.count() > 0) await cookieBtn.first().click();

  // Login
  await page.goto('https://www.csfd.cz/prihlaseni/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#frm-loginForm-nick', { timeout: 10000 });
  await page.fill('#frm-loginForm-nick', CSFD_USERNAME);
  await page.fill('#frm-loginForm-password', CSFD_PASSWORD);
  await page.check('#frm-loginForm-permanent');
  await page.click('button[name="send"]');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);

  const bodyText = await page.textContent('body');
  if (!bodyText.includes('Odhlásit')) {
    await browser.close();
    throw new Error('Login na ČSFD selhal — zkontroluj přezdívku a heslo v .env');
  }

  return { browser, context, page };
}

// --- Rating ---

export async function rateMovie(filmInput, stars) {
  const url = parseFilmUrl(filmInput);
  const dataRating = starsToDataRating(stars);
  const { browser, page } = await createSession();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    const filmTitle = await page.locator('h1').first().textContent();

    const starLink = page.locator(`.stars-rating a[data-rating="${dataRating}"]`);
    if (await starLink.count() === 0) {
      throw new Error(`Hvězdičky nenalezeny na ${url}`);
    }

    await starLink.click();
    await page.waitForTimeout(3000);

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
  const { browser, page } = await createSession();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

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

export async function getWatchlist({ allPages = false } = {}) {
  const { browser, page } = await createSession();

  try {
    const films = [];
    let currentPage = 1;

    while (true) {
      const url = `https://www.csfd.cz/soukrome/chci-videt/?page=${currentPage}&sort=inserted`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);

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

      // Je další stránka?
      const hasNext = await page.locator('a:has-text("další")').count();
      if (hasNext === 0) break;
      currentPage++;
    }

    return { films, pages: currentPage, total: films.length };
  } finally {
    await browser.close();
  }
}

export async function watchlistAdd(filmInput, note = '') {
  const url = parseFilmUrl(filmInput);
  const { browser, page } = await createSession();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    const filmTitle = await page.locator('h1').first().textContent();

    // Klikni "Chci vidět" button → otevře modal
    const wantSeeBtn = page.locator('a.btn-profile-action:has-text("Chci vidět")');
    if (await wantSeeBtn.count() === 0) {
      throw new Error(`Tlačítko "Chci vidět" nenalezeno na ${url}`);
    }
    await wantSeeBtn.click();
    await page.waitForTimeout(2000);

    // Zaškrtni "po ohodnocení vyřadit"
    const removeAfterRating = page.locator('#frm-watchlistForm-watchlistForm-remove_after_rating');
    if (await removeAfterRating.count() > 0) {
      await removeAfterRating.check();
    }

    // Vyplň poznámku
    if (note) {
      await page.fill('#frm-watchlistForm-watchlistForm-note', note);
    }

    // Submit
    await page.click('#watchlistForm button[name="ok"]');
    await page.waitForTimeout(3000);

    const pageText = await page.textContent('body');
    const success = pageText.includes('úspěšně') || pageText.includes('Odebrat z Chci vidět');

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
  const { browser, page } = await createSession();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    const filmTitle = await page.locator('h1').first().textContent();

    // Klikni "Chci vidět" → otevře modal
    const wantSeeBtn = page.locator('a.btn-profile-action:has-text("Chci vidět")');
    if (await wantSeeBtn.count() === 0) {
      throw new Error(`Tlačítko "Chci vidět" nenalezeno na ${url}`);
    }
    await wantSeeBtn.click();
    await page.waitForTimeout(2000);

    // Klikni "Odebrat" / submit remove form
    const removeBtn = page.locator('button:has-text("Odebrat"), button:has-text("odebrat"), #frm-watchlistForm-remove-form button[type="submit"]');
    if (await removeBtn.count() > 0) {
      await removeBtn.first().click();
    } else {
      // Fallback: submit remove form přímo
      await page.locator('#frm-watchlistForm-remove-form').evaluate(form => form.submit());
    }
    await page.waitForTimeout(3000);

    const pageText = await page.textContent('body');
    const success = pageText.includes('úspěšně') || pageText.includes('Přidat do Chci vidět');

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
  console.log(allPages ? 'Načítám celý watchlist...' : 'Načítám první stránku watchlistu...');
  const result = await getWatchlist({ allPages });
  console.log(`\n${result.total} filmů${allPages ? '' : ' (stránka 1)'}:\n`);
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

} else if (command) {
  console.error(`Neznámý příkaz: ${command}\nPříkazy: rate, check, watchlist, watchlist-add, watchlist-remove`);
  process.exit(1);
}
