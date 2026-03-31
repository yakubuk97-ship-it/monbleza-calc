#!/usr/bin/env node
/**
 * Zalando Germany scraper — New Balance sneakers
 * Iterates through all pages to collect all products
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');

const OUTPUT_FILE = 'zalando_data.json';
const BASE_URL = 'https://www.zalando.de/sneaker/new-balance/';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapePage(page, url, allProducts) {
  const before = allProducts.length;

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(2000);

  // Scroll once to trigger lazy loads
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(2000);

  return allProducts.length - before;
}

async function run() {
  console.log('Launching Chrome...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'de-DE,de;q=0.9' });
  await page.setViewport({ width: 1280, height: 900 });

  const allProducts = [];

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/api/graphql')) return;
    try {
      const data = await response.json();
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const edges = item?.data?.product?.family?.products?.edges;
        if (!edges) continue;
        for (const edge of edges) {
          const node = edge?.node;
          if (!node || !node.name) continue;
          const origAmount = node.displayPrice?.original?.amount;
          const promoAmount = node.displayPrice?.promotional?.amount;
          const sizes = (node.simples || []).map(s => s.size).filter(Boolean);
          allProducts.push({
            name: node.name,
            brand: node.brand?.name || 'New Balance',
            imageUrl: node.packshotImage?.uri || node.packShotThumbnail?.uri || '',
            currencySymbol: '€',
            originalPrice: origAmount || 0,
            promotionalPrice: promoAmount || null,
            productUrl: node.uri || '',
            sizes,
          });
        }
      }
    } catch (e) {}
  });

  // Iterate pages until empty
  let pageNum = 1;
  let emptyPages = 0;

  while (emptyPages < 2) {
    const url = pageNum === 1 ? BASE_URL : `${BASE_URL}?p=${pageNum}`;
    console.log(`Page ${pageNum}: ${url}`);
    const added = await scrapePage(page, url, allProducts);
    console.log(`  +${added} products (total raw: ${allProducts.length})`);

    if (added === 0) {
      emptyPages++;
    } else {
      emptyPages = 0;
    }
    pageNum++;

    if (pageNum > 30) break; // safety limit
  }

  await browser.close();

  console.log(`\nTotal raw: ${allProducts.length}`);

  // Deduplicate by productUrl
  const seen = new Set();
  const unique = allProducts.filter(p => {
    const key = p.productUrl || p.imageUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(unique, null, 2), 'utf-8');
  console.log(`Saved ${unique.length} unique products to ${OUTPUT_FILE}`);

  if (unique.length === 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
