// keyword_crawler.mjs
// Eseguito da GitHub Actions. Fa un crawling limitato di
// swisscom.ch/it/clienti-privati/*, cerca le parole chiave indicate e
// salva tutte le promozioni trovate in offers.json.

import { writeFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';

// ---------------------- CONFIG ----------------------
const START_URL = 'https://www.swisscom.ch/it/clienti-privati.html';
const ALLOWED_PREFIX = '/it/clienti-privati'; // resta solo dentro questa sezione
const HOST = 'www.swisscom.ch';

const KEYWORDS = ['netflix', 'disney', 'internet', 'tv', 'myservice', 'mysecurity'];

const MAX_PAGES = 80;           // limite pagine visitate per run
const REQUEST_DELAY_MS = 700;   // pausa tra le richieste (cortesia verso il sito)
const OUTPUT_FILE = 'offers.json';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// ------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'it-CH,it;q=0.9' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} su ${url}`);
  return res.text();
}

async function loadRobotsDisallow() {
  try {
    const txt = await fetchText(`https://${HOST}/robots.txt`);
    const lines = txt.split('\n').map((l) => l.trim());
    const disallow = [];
    let relevant = false;
    for (const line of lines) {
      if (/^user-agent:\s*\*/i.test(line)) { relevant = true; continue; }
      if (/^user-agent:/i.test(line)) { relevant = false; continue; }
      if (relevant && /^disallow:/i.test(line)) {
        const path = line.split(':').slice(1).join(':').trim();
        if (path) disallow.push(path);
      }
    }
    return disallow;
  } catch {
    return []; // se robots.txt non è raggiungibile, procedi senza regole extra
  }
}

function isDisallowed(pathname, disallowRules) {
  return disallowRules.some((rule) => pathname.startsWith(rule));
}

function normalizeUrl(href, baseUrl) {
  try {
    const u = new URL(href, baseUrl);
    u.hash = '';
    if (u.host !== HOST) return null;
    if (!u.pathname.startsWith(ALLOWED_PREFIX)) return null;
    if (!u.pathname.endsWith('.html') && u.pathname !== ALLOWED_PREFIX) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function extractPrice(text) {
  let m = text.match(/(Da\s+)?\d+[.,]\d{2}\s*\/\s*mese/i);
  if (m) return m[0].trim();
  m = text.match(/(Da\s+)?\d+[.,]–\s*\/\s*mese/i);
  return m ? m[0].trim() : null;
}

function extractPromo(text) {
  const patterns = [
    /\d+\s*mes[ei]\s+(gratis|in\s+regalo|in\s+omaggio)/i,
    /gratuito\s+per\s+il\s+primo\s+mese/i,
    /\d+\s*giorni?\s+di\s+prova\s+gratuita/i,
    /sconto\s+permanente\s+del\s+\d+%/i,
    /prezzo\s+esclusivo\s+per\s+i\s+clienti\s+swisscom/i,
    /incluso\s+(gratis|senza\s+costi\s+aggiuntivi)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0].trim();
  }
  return null;
}

/** Trova blocchi di testo che contengono una keyword e ne estrae uno snippet + link + prezzo/promo. */
function extractMatches($, pageUrl) {
  const found = [];
  const seenSnippets = new Set();

  // Candidati: titoli, elementi bold, link — punti dove di solito compare il nome del prodotto
  $('h1, h2, h3, h4, strong, b, a').each((_, el) => {
    const ownTextRaw = $(el).text().trim();
    if (!ownTextRaw) return;
    const ownText = ownTextRaw.replace(/\s+/g, ' ').trim();
    if (ownText.length > 160) return; // scarta paragrafi enormi come "titolo"

    const lower = ownText.toLowerCase();
    const matchedKeyword = KEYWORDS.find((k) => lower.includes(k));
    if (!matchedKeyword) return;

    // Risali a un contenitore ragionevole per prezzo/promo/link
    let container = $(el);
    let hops = 0;
    let contextText = container.text();
    while (contextText.length < 40 && hops < 4) {
      container = container.parent();
      contextText = container.text();
      hops++;
    }
    contextText = contextText.replace(/\s+/g, ' ').trim().slice(0, 400);

    const dedupKey = matchedKeyword + '|' + ownText;
    if (seenSnippets.has(dedupKey)) return;
    seenSnippets.add(dedupKey);

    let link = null;
    if (el.tagName === 'a') {
      link = $(el).attr('href');
    } else {
      const a = container.find('a').first();
      link = a.attr('href') || null;
    }
    const linkAbs = link ? normalizeUrl(link, pageUrl) || new URL(link, pageUrl).toString() : null;

    found.push({
      keyword: matchedKeyword,
      title: ownText,
      snippet: contextText,
      promo: extractPromo(contextText),
      price: extractPrice(contextText),
      link: linkAbs,
      found_on_page: pageUrl,
    });
  });

  return found;
}

async function crawl() {
  const disallowRules = await loadRobotsDisallow();

  const queue = [START_URL];
  const visited = new Set();
  const allMatches = [];

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    const { pathname } = new URL(url);
    if (isDisallowed(pathname, disallowRules)) {
      console.log(`Skip (robots.txt): ${url}`);
      continue;
    }

    try {
      console.log(`Visito (${visited.size}/${MAX_PAGES}): ${url}`);
      const html = await fetchText(url);
      const $ = cheerio.load(html);

      // Rimuove tag che non contengono mai testo utile e che spesso
      // "sporcano" il textContent (CSS inline, script, tracking, ecc.)
      $('style, script, noscript, svg, iframe').remove();

      allMatches.push(...extractMatches($, url));

      $('a[href]').each((_, a) => {
        const next = normalizeUrl($(a).attr('href'), url);
        if (next && !visited.has(next) && !queue.includes(next)) {
          queue.push(next);
        }
      });
    } catch (err) {
      console.error(`Errore su ${url}: ${err.message}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  return allMatches;
}

async function main() {
  const rawMatches = await crawl();

  // Tiene solo le voci che sembrano vere promozioni: deve esserci
  // almeno un prezzo o un testo promo riconosciuto. Scarta le semplici
  // etichette di prodotto (es. "Internet S", "Internet M") senza contesto.
  const matches = rawMatches.filter((m) => m.price !== null || m.promo !== null);

  if (matches.length === 0) {
    console.error('Nessuna corrispondenza con prezzo/promo trovata.');
    process.exit(1);
  }

  const payload = {
    scraped_at: new Date().toISOString(),
    start_url: START_URL,
    keywords: KEYWORDS,
    total_matches: matches.length,
    total_matches_before_filter: rawMatches.length,
    offers: matches,
  };

  await writeFile(OUTPUT_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`OK: ${matches.length} corrispondenze salvate in ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
