#!/usr/bin/env node
/**
 * Answear.com scraper
 * Phase 1: Puppeteer → collect product IDs (restarts browser every 15 brands)
 * Phase 2: In-browser fetch → /api/product/{id} in parallel
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');

const OUTPUT_FILE   = 'answear_data.json';
const IDS_CACHE     = 'answear_ids_cache.json';
const CHROME_PATH   = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAX_PAGES     = 5;    // 80 products/page → max 400 per brand
const BATCH         = 10;   // sequential API calls per round
const BROWSER_RESET = 15;   // restart browser every N brands (free memory)

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const BRAND_SLUGS = [
  'adidas', 'adidas-originals', 'nike', 'new-balance', 'puma', 'converse',
  'vans', 'the-north-face', 'columbia', 'helly-hansen',
  'tommy-hilfiger', 'tommy-jeans', 'calvin-klein', 'calvin-klein-jeans',
  'polo-ralph-lauren', 'hugo', 'boss',
  'lacoste', 'fred-perry',
  'levis', 'pepe-jeans', 'diesel',
  'jack-wolfskin', 'under-armour',
  'hollister-co', 'medicine', 'answear-lab',
  'birkenstock', 'ugg', 'dr-martens',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function makeBrowser() {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--memory-pressure-off', '--max-old-space-size=512'],
  });
}

// Resolve which brand+gender pages exist on answear.com
async function resolveBrandUrls() {
  const browser = await makeBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 800 });

  const available = new Set();
  for (const gender of ['on', 'ona']) {
    await page.goto(`https://answear.com/c/${gender}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(600);
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/m/"]'))
        .map(a => a.href).filter(h => /\/m\/[^/]+\/(on|ona)$/.test(h))
    );
    links.forEach(l => available.add(l));
  }
  await browser.close();

  const urls = [];
  for (const slug of BRAND_SLUGS) {
    for (const gender of ['on', 'ona']) {
      const url = `https://answear.com/m/${slug}/${gender}`;
      if (available.has(url)) urls.push(url);
    }
  }
  return [...new Set(urls)];
}

// Collect product entries from one brand URL
async function scrapeBrand(page, brandUrl) {
  const entries = new Map();
  try {
    await page.goto(brandUrl, { waitUntil: 'networkidle2', timeout: 40000 });
    await sleep(250);

    const maxPage = await page.evaluate(() => {
      const nums = Array.from(document.querySelectorAll('a[href*="?page="]'))
        .map(a => { const m = a.href.match(/[?&]page=(\d+)/); return m ? +m[1] : 0; });
      return nums.length ? Math.max(...nums) : 1;
    });

    for (let p = 1; p <= Math.min(maxPage, MAX_PAGES); p++) {
      if (p > 1) {
        await page.goto(`${brandUrl}?page=${p}`, { waitUntil: 'networkidle2', timeout: 40000 });
        await sleep(200);
      }
      const cards = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-test="productItem"]')).map(card => {
          const href = card.href || '';
          const src  = card.querySelector('source')?.srcset?.split(' ')?.[0] || card.querySelector('img')?.src || '';
          const img  = src.replace(/\/i\/\d+x\d+\//, '/i/400x600/').replace(/\.avif(\?|$)/, '.jpg$1');
          const m    = href.match(/-(\d+)$/);
          return m ? { id: m[1], url: href, img } : null;
        }).filter(Boolean)
      );
      cards.forEach(c => entries.set(c.id, c));
      if (cards.length < 40) break;
    }
  } catch { /* skip */ }
  return [...entries.values()];
}

// Fetch product details in parallel via /api/product/{id}
function parseProduct(p, entry) {
  if (!p?.price) return null;
  const priceRegular = (p.priceRegular && p.priceRegular > p.price) ? p.priceRegular : null;
  const sizes = (p.allSizes || []).filter(s => s.variation?.availability === 'IN_STOCK').map(s => s.name).filter(Boolean);
  const imgName = p.productImages?.mainImage?.name;
  const imgVer  = p.productImages?.mainImage?.version;
  const img = imgName
    ? `https://img2.ans-media.com/i/400x600/${imgName.replace(/\.avif$/, '.jpg')}${imgVer ? '?v=' + imgVer : ''}`
    : entry.img;
  const url = entry.url || (p.slug ? `https://answear.com/p/${p.slug}-${p.id}` : '');
  return { id: String(p.id), name: p.name || '', brand: p.productBrand?.name || '', price: p.price, priceRegular, currency: 'PLN', sizes, img: entry.img || img, url, source: 'answear' };
}

async function fetchBatch(page, entries) {
  const ids = entries.map(e => e.id);
  const results = await page.evaluate(async (ids) => {
    const out = [];
    for (const id of ids) {
      try {
        const r = await fetch(`/api/product/${id}`, {
          headers: { 'x-tamago-api-version': '3.37', 'x-tamago-app': 'frontApp', 'x-tamago-locale': 'pl', 'Accept': 'application/json' }
        });
        const json = await r.json();
        out.push({ id, data: json.product || null, status: r.status, errType: json.type || null });
      } catch(e) { out.push({ id, data: null, status: 0, err: e.message }); }
      await new Promise(r => setTimeout(r, 150));
    }
    return out;
  }, ids);
  // Log first failure to understand the issue
  const firstFail = results.find(r => !r.data);
  if (firstFail) process.stdout.write(`\n  FAIL sample: status=${firstFail.status} type=${firstFail.errType} err=${firstFail.err}`);
  return results.map((r, i) => parseProduct(r.data, entries[i])).filter(Boolean);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('=== Answear.com Scraper ===\n');

  // ── Phase 1 ────────────────────────────────────────────────────────────────
  let allEntries;

  if (fs.existsSync(IDS_CACHE)) {
    const cached = JSON.parse(fs.readFileSync(IDS_CACHE, 'utf-8'));
    allEntries = new Map(cached.map(e => [e.id, e]));
    console.log(`Phase 1: Loaded ${allEntries.size} IDs from cache (${IDS_CACHE})\n`);
  } else {
    console.log('Phase 1: Resolving brand URLs...');
    const brandUrls = await resolveBrandUrls();
    console.log(`Targeting ${brandUrls.length} brand pages\n`);

    allEntries = new Map();
    let browser = await makeBrowser();
    let page    = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 800 });

    for (let i = 0; i < brandUrls.length; i++) {
      const url   = brandUrls[i];
      const label = url.replace('https://answear.com/m/', '');
      process.stdout.write(`\r  [${i+1}/${brandUrls.length}] ${label.padEnd(32)} total: ${allEntries.size}`);

      const entries = await scrapeBrand(page, url);
      entries.forEach(e => allEntries.set(e.id, e));

      // Restart browser every BROWSER_RESET brands to free memory
      if ((i + 1) % BROWSER_RESET === 0 && i + 1 < brandUrls.length) {
        await page.close();
        await browser.close();
        await sleep(1000);
        browser = await makeBrowser();
        page    = await browser.newPage();
        await page.setUserAgent(UA);
        await page.setViewport({ width: 1280, height: 800 });
      }
      await sleep(120);
    }

    await page.close();
    await browser.close();

    const list = [...allEntries.values()];
    fs.writeFileSync(IDS_CACHE, JSON.stringify(list));
    console.log(`\n\nTotal unique product IDs: ${list.length}\n`);
  }

  const entriesList = [...allEntries.values()];
  if (!entriesList.length) { console.error('No products!'); process.exit(1); }

  // ── Phase 2 ────────────────────────────────────────────────────────────────
  console.log('Phase 2: Fetching product details...');

  const browser = await makeBrowser();
  const apiPage = await browser.newPage();
  await apiPage.setUserAgent(UA);
  await apiPage.goto('https://answear.com/m/adidas/on', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(600);

  // Resume: skip already-fetched IDs
  const existingIds = new Set();
  if (fs.existsSync(OUTPUT_FILE)) {
    const existing = JSON.parse(fs.readFileSync(OUTPUT_FILE));
    existing.forEach(p => existingIds.add(String(p.id)));
    console.log(`Resuming: ${existingIds.size} already fetched, skipping them`);
  }
  const pendingEntries = entriesList.filter(e => !existingIds.has(String(e.id)));
  console.log(`Pending: ${pendingEntries.length} to fetch\n`);

  const allProducts = fs.existsSync(OUTPUT_FILE) ? JSON.parse(fs.readFileSync(OUTPUT_FILE)) : [];
  let done = 0, errors = 0;
  let consecutiveEmpty = 0;
  let currentBrowser = browser;
  let currentPage = apiPage;

  for (let i = 0; i < pendingEntries.length; i += BATCH) {
    const batch = pendingEntries.slice(i, i + BATCH);
    let products = [];
    try {
      products = await fetchBatch(currentPage, batch);
    } catch(e) {
      // page died - open fresh browser
    }
    allProducts.push(...products);
    const batchErrors = batch.length - products.length;
    errors += batchErrors;
    done += batch.length;

    // Rate-limit recovery: restart browser (new session) after 3 empty batches
    if (products.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty === 3) {
        const total = allProducts.length;
        console.log(`\n  Rate limited at ${total} products. Restarting browser (new session)...`);
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allProducts, null, 2));
        try { await currentPage.close(); } catch {}
        try { await currentBrowser.close(); } catch {}
        await sleep(5000);
        currentBrowser = await makeBrowser();
        currentPage = await currentBrowser.newPage();
        await currentPage.setUserAgent(UA);
        await currentPage.goto('https://answear.com/m/adidas/on', { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(2000);
        consecutiveEmpty = 0;
        console.log('  New session ready, resuming...');
      }
    } else {
      consecutiveEmpty = 0;
    }

    if (done % 250 === 0 || done === pendingEntries.length) {
      process.stdout.write(`\r  ${done}/${pendingEntries.length} pending | total: ${allProducts.length} | errors: ${errors}   `);
      if (done % 1000 === 0) fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allProducts, null, 2));
    }
    await sleep(100);
  }

  try { await currentPage.close(); } catch {}
  await currentBrowser.close();

  console.log(`\n\nDone! ${allProducts.length} products`);
  const brands = {};
  allProducts.forEach(p => { brands[p.brand] = (brands[p.brand]||0)+1; });
  console.log('Top brands:', Object.entries(brands).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([b,n])=>`${b}:${n}`).join(', '));

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allProducts, null, 2));
  // Clean up cache
  if (fs.existsSync(IDS_CACHE)) fs.unlinkSync(IDS_CACHE);
  console.log(`Saved → ${OUTPUT_FILE}`);

  if (!allProducts.length) process.exit(1);
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
