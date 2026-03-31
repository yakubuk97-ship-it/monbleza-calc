#!/usr/bin/env node
/**
 * Zalando Germany scraper — New Balance men's shoes
 * Intercepts GraphQL responses to extract product data
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');

const OUTPUT_FILE = 'zalando_data.json';
const CATALOG_URL = 'https://www.zalando.de/sneaker/new-balance/';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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

  const allProducts = [];

  // Intercept GraphQL responses and extract product data
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/api/graphql')) return;

    try {
      const data = await response.json();
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        // Each item: { data: { product: { family: { products: { edges: [...] } } } } }
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
            originalPrice: origAmount || 0,       // in cents, e.g. 11995 = €119.95
            promotionalPrice: promoAmount || null, // in cents
            productUrl: node.uri || '',
            sizes,
          });
        }
      }
    } catch (e) {}
  });

  console.log('Opening Zalando catalog...');
  await page.goto(CATALOG_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));

  await browser.close();

  console.log(`Collected ${allProducts.length} products from GraphQL`);

  // Deduplicate by imageUrl
  const seen = new Set();
  const unique = allProducts.filter(p => {
    if (!p.imageUrl || seen.has(p.imageUrl)) return false;
    seen.add(p.imageUrl);
    return true;
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(unique, null, 2), 'utf-8');
  console.log(`Saved ${unique.length} products to ${OUTPUT_FILE}`);

  if (unique.length === 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
