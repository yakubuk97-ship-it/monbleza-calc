#!/usr/bin/env node
/**
 * Zalando Germany scraper — New Balance sneakers
 * Iterates through all pages to collect all products
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');

const OUTPUT_FILE = 'zalando_data.json';
const BRAND_URLS = [
  // Кроссовки — бренды (sneaker category pages)
  'https://www.zalando.de/sneaker/new-balance/',
  'https://www.zalando.de/sneaker/nike/',
  'https://www.zalando.de/sneaker/adidas/',
  'https://www.zalando.de/sneaker/puma/',
  'https://www.zalando.de/sneaker/converse/',
  'https://www.zalando.de/sneaker/vans/',
  'https://www.zalando.de/sneaker/reebok/',
  'https://www.zalando.de/sneaker/asics/',
  'https://www.zalando.de/sneaker/jordan/',
  'https://www.zalando.de/sneaker/salomon/',
  'https://www.zalando.de/sneaker/on/',
  'https://www.zalando.de/sneaker/diadora/',
  // Одежда — мужские страницы брендов (clothing captured via direct product handler)
  'https://www.zalando.de/herren/new-balance/',
  'https://www.zalando.de/herren/nike/',
  'https://www.zalando.de/herren/adidas/',
  'https://www.zalando.de/herren/puma/',
  'https://www.zalando.de/herren/carhartt/',
  'https://www.zalando.de/herren/fred-perry/',
  'https://www.zalando.de/herren/stone-island/',
  'https://www.zalando.de/herren/lacoste/',
  'https://www.zalando.de/herren/tommy-hilfiger/',
  'https://www.zalando.de/herren/ralph-lauren/',
  'https://www.zalando.de/herren/champion/',
  'https://www.zalando.de/herren/dickies/',
];
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
  const seenUrls = new Set();

  function extractEdges(item) {
    // Try all known Zalando GraphQL response structures
    return (
      item?.data?.product?.family?.products?.edges ||          // brand sneaker pages
      item?.data?.search?.products?.edges ||                   // search/category pages
      item?.data?.catalog?.products?.edges ||                  // catalog pages
      item?.data?.categorySearch?.products?.edges ||           // category search
      item?.data?.esSearch?.products?.edges ||                 // ES search variant
      null
    );
  }

  function pushProduct(node) {
    if (!node?.name) return false;
    const productUrl = node.uri || '';
    if (seenUrls.has(productUrl)) return false;
    seenUrls.add(productUrl);
    const origAmount = node.displayPrice?.original?.amount;
    const promoAmount = node.displayPrice?.promotional?.amount;
    const sizes = (node.simples || []).map(s => s.size).filter(Boolean);
    // Determine image: try several field names
    const imageUrl = node.packshotImage?.uri
      || node.packShotThumbnail?.uri
      || node.mediumPackshotImage?.uri
      || node.smallPackshotImage?.uri
      || node.defaultMediaInfo?.uri
      || node.mediumDefaultMedia?.uri
      || '';
    allProducts.push({
      name: node.name,
      brand: node.brand?.name || '',
      imageUrl,
      currencySymbol: '€',
      originalPrice: origAmount || 0,
      promotionalPrice: promoAmount || null,
      productUrl,
      sizes,
    });
    return true;
  }

  page.on('response', async (response) => {
    const url = response.url();
    if (!url.includes('/api/graphql')) return;
    try {
      const data = await response.json();
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        // Handler 1: family.products.edges (brand sneaker category pages)
        const edges = extractEdges(item);
        if (edges) {
          for (const edge of edges) {
            pushProduct(edge?.node);
          }
          continue;
        }
        // Handler 2: direct data.product (individual product card responses)
        const product = item?.data?.product;
        if (product?.name && product?.displayPrice && product?.uri) {
          pushProduct(product);
        }
      }
    } catch (e) {}
  });

  // Iterate all brands and their pages
  for (const BASE_URL of BRAND_URLS) {
    console.log(`\n=== Brand: ${BASE_URL.split('/').filter(Boolean).pop()} ===`);
    let pageNum = 1;
    let emptyPages = 0;

    while (emptyPages < 2) {
      const sep = BASE_URL.includes('?') ? '&' : '?';
      const url = pageNum === 1 ? BASE_URL : `${BASE_URL}${sep}p=${pageNum}`;
      console.log(`  Page ${pageNum}`);
      const added = await scrapePage(page, url, allProducts);
      console.log(`  +${added} (total raw: ${allProducts.length})`);

      if (added === 0) emptyPages++;
      else emptyPages = 0;
      pageNum++;
      if (pageNum > 30) break;
    }
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
