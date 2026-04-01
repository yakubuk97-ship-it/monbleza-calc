#!/usr/bin/env node
/**
 * StreetStyle24.pl scraper — fetches product data from __NEXT_DATA__ SSR JSON
 * No Puppeteer needed — plain HTTP requests
 */

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');

const OUTPUT_FILE = 'streetstyle_data.json';
const SITEMAP_PAGES = 6;
const CONCURRENCY = 5;        // parallel requests
const DELAY_MS = 300;         // delay between batches

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'pl-PL,pl;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }, (res) => {
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      let data = '';
      stream.on('data', chunk => data += chunk);
      stream.on('end', () => resolve(data));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getSitemapUrls() {
  const allUrls = [];
  for (let pg = 1; pg <= SITEMAP_PAGES; pg++) {
    try {
      const xml = await getHtml(`https://streetstyle24.pl/sitemap/render/product.xml?page=${pg}`);
      const matches = xml.match(/<loc>(https:\/\/streetstyle24\.pl\/[^<]+)<\/loc>/g) || [];
      const urls = matches.map(m => m.replace(/<\/?loc>/g, ''));
      if (!urls.length) break;
      console.log(`Sitemap page ${pg}: ${urls.length} URLs`);
      allUrls.push(...urls);
    } catch (e) {
      console.error(`Sitemap page ${pg} error:`, e.message);
    }
  }
  return allUrls;
}

function extractProduct(html, url) {
  try {
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
    if (!m) return null;

    const nd = JSON.parse(m[1]);
    const queries = nd.props?.pageProps?.dehydratedState?.queries || [];
    const productQ = queries.find(q => q.queryKey?.[0] === 'product');
    if (!productQ) return null;

    const p = productQ.state?.data?.product;
    if (!p?.name) return null;

    // Price in PLN
    const sellPrice = p.prices?.sellPrice?.gross || 0;
    const basePrice = p.prices?.basePrice?.gross || null;
    if (!sellPrice) return null;

    // Image
    const picCat = p.picturesCategories?.find(c => c.slug !== '--empty--' && c.pictures?.length);
    const imgHash = picCat?.pictures?.[0]?.filename?.replace('{imageSafeUri}/', '');
    const imageUrl = imgHash
      ? `https://streetstyle24.pl/picture/fit-in/600x600/smart/${imgHash}`
      : '';

    // Sizes from variants
    const sizes = (p.variants || [])
      .map(v => v.option)
      .filter(Boolean)
      .filter(s => s.trim() !== '');

    // Name cleanup: remove trailing " - color" part for display
    const raw = (p.name || '').trim();

    return {
      name: raw,
      brand: p.producer?.name || '',
      imageUrl,
      sellPrice,                                  // PLN sell price
      basePrice: basePrice !== sellPrice ? basePrice : null,  // PLN original if different
      currency: 'PLN',
      productUrl: url,
      sizes,
      source: 'ss24',
    };
  } catch (e) {
    return null;
  }
}

async function processBatch(urls) {
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const html = await getHtml(url);
        return extractProduct(html, url);
      } catch (e) {
        return null;
      }
    })
  );
  return results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
}

async function run() {
  console.log('=== StreetStyle24.pl Scraper ===\n');

  // Step 1: Get all product URLs from sitemap
  console.log('Fetching sitemap...');
  const urls = await getSitemapUrls();
  console.log(`\nTotal product URLs: ${urls.length}\n`);

  if (!urls.length) {
    console.error('No URLs found, exiting');
    process.exit(1);
  }

  // Step 2: Scrape all product pages in batches
  const allProducts = [];
  let done = 0;
  let errors = 0;

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const products = await processBatch(batch);

    allProducts.push(...products);
    done += batch.length;
    errors += batch.length - products.length;

    if (done % 100 === 0 || done === urls.length) {
      process.stdout.write(`\r  Progress: ${done}/${urls.length} | found: ${allProducts.length} | errors: ${errors}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n\nDone! Scraped ${allProducts.length} products (${errors} errors)\n`);

  // Step 3: Save
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allProducts, null, 2), 'utf-8');
  console.log(`Saved to ${OUTPUT_FILE}`);

  // Stats
  const brands = {};
  allProducts.forEach(p => { brands[p.brand] = (brands[p.brand] || 0) + 1; });
  console.log('\nTop brands:');
  Object.entries(brands).sort((a,b) => b[1]-a[1]).slice(0,15).forEach(([b,n]) => console.log(`  ${b}: ${n}`));

  const withSizes = allProducts.filter(p => p.sizes?.length > 0).length;
  const onSale = allProducts.filter(p => p.basePrice && p.basePrice > p.sellPrice).length;
  console.log(`\nWith sizes: ${withSizes}/${allProducts.length}`);
  console.log(`On sale: ${onSale}/${allProducts.length}`);

  if (allProducts.length === 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
