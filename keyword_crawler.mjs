// fixed_pages_scraper.mjs
// Visita SOLO le pagine elencate in PAGES (nessun crawling del resto del sito),
// cerca le keyword indicate e salva le promozioni trovate in offers.json.
// Eseguito da GitHub Actions.

import { writeFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';

// ---------------------- CONFIG ----------------------
const PAGES = [
  'https://www.swisscom.ch/it/clienti-privati/abbonamento-tv/pacchetti-supplementari.html',
  'https://www.swisscom.ch/it/clienti-privati/abbonamento-internet/sicuro-in-modo-digitale.html',
  'https://www.swisscom.ch/it/clienti-privati/abbonamento-tv.html',
  'https://www.swisscom.ch/it/clienti-privati/abbonamento-internet/myservice.html',
];

const KEYWORD_VARIANTS = {
  netflix: ['netflix'],
  disney: ['disney'],
  'blue binge': ['blue binge'],
  myservice: ['myservice', 'my service'],
  mysecurity: ['mysecurity', 'my security'],
  tv: ['tv'],
};

const REQUEST_DELAY_MS = 700;
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

function extractPrice(text) {
  let m = text.match(/(Da\s+)?\d+[.,]\d{2}\s*\/\s*mese/i);
  if (m) return m[0].trim();
  m = text.match(/(Da\s+)?\d+[.,]–\s*\/\s*mese/i);
  return m ? m[0].trim() : null;
}

function extractPromo(text) {
  const patterns = [
    /\d+\s*mes[ei]\s+.{0,50}?(gratis|in\s+regalo|in\s+omaggio|gratuit[io])/i,
    /\d+\s*mes[ei]\s+di\s+[\w\s+]+?\s+come\s+credito/i,
    /gratuito\s+per\s+il\s+primo\s+mese/i,
    /\d+\s*giorni?\s+di\s+prova\s+gratuita/i,
    /sconto\s+permanente\s+del\s+\d+%/i,
    /incluso\s+(gratis|senza\s+costi\s+aggiuntivi)/i,
    /credito\s*\(valore\s+totale/i,
    /extra\s+gratuit[io]/i,
    /1\s*mese\s+in\s+regalo/i,
    /\d+[.,]?[–-]?\s*per\s+\d+\s*mes[ei]/i,       // es. "0.– per 1 mese"
    /primo\s+mese\s+(gratis|gratuito|a\s+\d+[.,]\d{2})/i,
    /prezzo\s+ridotto\s+per\s+i\s+primi\s+\d+\s*mes[ei]/i,
    /primi\s+\d+\s*mes[ei]\s+.{0,30}?(scontat[oi]|ridott[oi])/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0].trim();
  }
  return null;
}

function matchKeyword(lowerText) {
  for (const [canonical, variants] of Object.entries(KEYWORD_VARIANTS)) {
    if (variants.some((v) => lowerText.includes(v))) return canonical;
  }
  return null;
}

function extractMatches($, pageUrl) {
  const found = [];
  const seenSnippets = new Set();

  function pushMatch(matchedKeyword, ownText, container, linkOverride) {
    const dedupKey = matchedKeyword + '|' + ownText;
    if (seenSnippets.has(dedupKey)) return;
    seenSnippets.add(dedupKey);

    let contextText = container.text().replace(/\s+/g, ' ').trim();
    if (contextText.length < 40) contextText = ownText;
    contextText = contextText.slice(0, 400);

    let link = linkOverride;
    if (!link) {
      const a = container.is('a') ? container : container.find('a').first();
      link = a.attr ? a.attr('href') : null;
    }
    let linkAbs = null;
    if (link) {
      try { linkAbs = new URL(link, pageUrl).toString(); } catch { linkAbs = null; }
    }

    found.push({
      keyword: matchedKeyword,
      title: ownText,
      snippet: contextText,
      promo: extractPromo(contextText),
      price: extractPrice(contextText),
      link: linkAbs,
      found_on_page: pageUrl,
    });
  }

  $('h1, h2, h3, h4, h5, strong, b, a, span, p, li').each((_, el) => {
    const ownTextRaw = $(el).text().trim();
    if (!ownTextRaw) return;
    const ownText = ownTextRaw.replace(/\s+/g, ' ').trim();
    if (ownText.length > 160) return;

    const lower = ownText.toLowerCase();
    const matchedKeyword = matchKeyword(lower);
    if (!matchedKeyword) return;

    let container = $(el);
    let hops = 0;
    while (container.text().trim().length < 40 && hops < 4) {
      container = container.parent();
      hops++;
    }

    const link = el.tagName === 'a' ? $(el).attr('href') : null;
    pushMatch(matchedKeyword, ownText, container, link);
  });

  $('img[alt]').each((_, el) => {
    const alt = ($(el).attr('alt') || '').trim();
    if (!alt) return;
    const lower = alt.toLowerCase();
    const matchedKeyword = matchKeyword(lower);
    if (!matchedKeyword) return;

    let container = $(el).parent();
    let hops = 0;
    while (container.text().trim().length < 40 && hops < 5) {
      container = container.parent();
      hops++;
    }
    pushMatch(matchedKeyword, alt, container, null);
  });

  return found;
}

async function main() {
  const rawMatches = [];

  for (const url of PAGES) {
    try {
      console.log(`Visito: ${url}`);
      const html = await fetchText(url);
      const $ = cheerio.load(html);
      $('style, script, noscript, svg, iframe').remove();

      const matches = extractMatches($, url);
      console.log(`  -> ${matches.length} corrispondenze grezze`);
      rawMatches.push(...matches);
    } catch (err) {
      console.error(`Errore su ${url}: ${err.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  // Tiene solo le voci con un prezzo o una promo reale
  const qualityFiltered = rawMatches.filter((m) => m.price !== null || m.promo !== null);

  // Deduplica globale
  const globalSeen = new Set();
  const matches = [];
  for (const m of qualityFiltered) {
    const key = `${m.keyword}|${m.title}|${m.price}|${m.promo}`;
    if (globalSeen.has(key)) continue;
    globalSeen.add(key);
    matches.push(m);
  }

  if (matches.length === 0) {
    console.error('Nessuna corrispondenza con prezzo/promo trovata.');
    process.exit(1);
  }

  const payload = {
    scraped_at: new Date().toISOString(),
    pages: PAGES,
    keywords: Object.keys(KEYWORD_VARIANTS),
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
