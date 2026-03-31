#!/usr/bin/env node
/**
 * Zalando Germany scraper — New Balance sneakers
 * Output: zalando_data.json (same format as Apify Zalando Scraper)
 *
 * Usage:
 *   node scraper.js
 *
 * Install deps first:
 *   npm install axios
 */

const axios = require('axios');
const fs = require('fs');

const BRAND_SLUG = 'new-balance';
const CATEGORY = 'herren-schuhe';           // men's shoes
const BASE_URL = 'https://www.zalando.de';
const PER_PAGE = 84;                        // max per request
const OUTPUT_FILE = 'zalando_data.json';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': `${BASE_URL}/new-balance-schuhe-herren/`,
  'x-xsrf-token': '',
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch one page from Zalando catalog API.
 * Zalando uses /api/catalog/articles with query params.
 */
async function fetchPage(offset) {
  const url = `${BASE_URL}/api/catalog/articles`;
  const params = {
    brands: BRAND_SLUG,
    category: CATEGORY,
    per_page: PER_PAGE,
    offset,
  };

  const resp = await axios.get(url, {
    headers: HEADERS,
    params,
    timeout: 30000,
  });

  return resp.data;
}

/**
 * Map a Zalando catalog article to the Apify output schema.
 */
function mapArticle(item) {
  const entity = item.entity || item;

  const name = entity.name || '';
  const brand = entity.brand?.name || entity.brandName || 'New Balance';

  // Zalando prices come as integers in cents
  const originalPrice = entity.price?.original ?? entity.displayPrice?.value ?? 0;
  const promotionalPrice = entity.price?.promotional ?? entity.displayPrice?.promotional ?? null;

  // First media item
  const imageUrl = (entity.media?.[0]?.path
    ? `https://img01.ztat.net/article/${entity.media[0].path}?imwidth=300&filter=packshot`
    : entity.imageUrl || '');

  const sku = entity.sku || entity.id || '';
  const productUrl = sku
    ? `${BASE_URL}/${sku}.html`
    : (entity.url ? `${BASE_URL}${entity.url}` : '');

  return {
    name,
    brand,
    imageUrl,
    currencySymbol: '€',
    originalPrice,
    promotionalPrice: promotionalPrice || null,
    productUrl,
  };
}

async function run() {
  console.log(`Scraping Zalando Germany — brand: ${BRAND_SLUG}, category: ${CATEGORY}`);

  let allItems = [];
  let offset = 0;
  let total = null;

  while (true) {
    console.log(`  Fetching offset=${offset}...`);

    let data;
    try {
      data = await fetchPage(offset);
    } catch (err) {
      if (err.response) {
        console.error(`  HTTP ${err.response.status} at offset=${offset}`);
        // Some offsets may return 404 when past the end — treat as done
        if (err.response.status === 404) break;
      }
      throw err;
    }

    // Support two known response shapes
    const articles = data.articles ?? data.items ?? [];
    if (total === null) {
      total = data.pagination?.totalCount ?? data.total ?? articles.length;
      console.log(`  Total reported by API: ${total}`);
    }

    if (articles.length === 0) break;

    allItems = allItems.concat(articles.map(mapArticle));
    offset += PER_PAGE;

    if (offset >= total) break;

    // Polite delay between pages
    await sleep(1500 + Math.random() * 1000);
  }

  // Deduplicate by imageUrl (same logic as generate.py)
  const seen = new Set();
  const unique = allItems.filter(p => {
    if (seen.has(p.imageUrl)) return false;
    seen.add(p.imageUrl);
    return true;
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(unique, null, 2), 'utf-8');
  console.log(`\nSaved ${unique.length} unique products to ${OUTPUT_FILE}`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
