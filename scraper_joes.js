#!/usr/bin/env node
/**
 * Joe's New Balance Outlet scraper.
 * Uses ScrapFly with asp=true and country=us to bypass Akamai.
 * Strategy: Demandware Search-UpdateGrid AJAX endpoint (1 credit per ~200 products).
 *
 * Output: joes_data.json — array of products matching the shape used by generate.py.
 */
require('dotenv').config();
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');

const KEY = process.env.SCRAPFLY_KEY;
if (!KEY) { console.error('SCRAPFLY_KEY missing'); process.exit(1); }

const BASE = 'https://www.joesnewbalanceoutlet.com';
const GRID = '/on/demandware.store/Sites-JNBO-Site/en_US/Search-UpdateGrid';
const OUTPUT = 'joes_data.json';

// Categories to scrape (cgid discovered for /men, rest via landing-page probe)
const CATEGORIES = [
  { name: 'men',   path: '/men',   cgid: '1000' },   // already known
  { name: 'women', path: '/women', cgid: null   },   // discover
  { name: 'kids',  path: '/kids',  cgid: null   },
];

const PAGE_SIZE = 200;
// Default — умеренный прогон (помещается в бюджет ScrapFly при запуске раз в 3 дня).
// Можно переопределить через env: JOES_MAX_PAGES=10 node scraper_joes.js
const MAX_PAGES_PER_CAT = parseInt(process.env.JOES_MAX_PAGES || '4', 10);

function sfFetch(url, { render = false, timeout = 120000 } = {}) {
  const params = new URLSearchParams({
    key: KEY,
    url,
    asp: 'true',
    country: 'us',
    format: 'raw',
  });
  if (render) params.set('render_js', 'true');
  return axios.get(`https://api.scrapfly.io/scrape?${params}`, {
    timeout,
    validateStatus: () => true,
  });
}

async function discoverCgid(path) {
  console.log(`  [discover] ${path}`);
  const r = await sfFetch(BASE + path, { render: false });  // no JS render — cheaper
  const html = r.data?.result?.content || '';
  const cost = r.data?.context?.cost?.total;
  fs.writeFileSync(`joes_raw${path.replace(/\//g, '_')}.html`, html);
  const m =
    html.match(/Search-UpdateGrid[^"']*cgid=(\d+)/i) ||
    html.match(/data-cgid="(\d+)"/i) ||
    html.match(/["'&]cgid["']?\s*[:=]\s*["']?(\d+)/i) ||
    html.match(/cgid=(\d+)/);
  const cgid = m ? m[1] : null;
  console.log(`    cost ${cost}  cgid=${cgid}  html=${html.length}b`);
  return cgid;
}

function parseTile($, el) {
  // `el` is the parent container (.pgptiles) — contains both tealium span and [data-pid] div
  const $el = $(el);
  const pid = $el.find('[data-pid]').first().attr('data-pid') || '';
  if (!pid) return null;

  // Tealium JSON blob per tile (has name, brand, color, gender, category, etc.)
  let ga = null;
  const gaAttr = $el.find('[data-tealium-product-tile-data]').first().attr('data-tealium-product-tile-data');
  if (gaAttr) {
    try { ga = JSON.parse(gaAttr); } catch (e) {}
  }
  if (!ga) {
    const outer = $.html($el);
    const decoded = outer.replace(/&quot;/g, '"');
    const jm = decoded.match(/\{"masterProductId"[\s\S]+?"itemVariant":"[^"]*"\}/);
    if (jm) { try { ga = JSON.parse(jm[0]); } catch (e) {} }
  }

  const name = (ga && ga.productName) || $el.find('.pdp-link a, .product-name, .link').first().text().trim() || '';
  const brand = (ga && ga.brand) || 'New Balance';
  const color = (ga && ga.color) || '';
  const productType = (ga && (ga.productType || ga.productGbu)) || '';  // Running/Lifestyle/Training/Apparel
  const line = (ga && ga.line) || '';  // Shoes / Apparel / Accessories
  const gender = (ga && ga.gender) || '';

  // URL
  const href = $el.find('a.tile-link, a[href*="/pd/"]').first().attr('href') || '';
  const productUrl = href.startsWith('http') ? href : (BASE + href);

  // Images — primary + hover (scene7)
  const collectImg = (sel) => {
    const img = $el.find(sel).first();
    return img.attr('data-src') || img.attr('src') || '';
  };
  const primary = collectImg('picture.firstImage img, picture.main-image img');
  const hover = collectImg('picture.nextImage img, picture.next-main-image img');
  const images = [primary, hover].filter(u => u && !u.startsWith('data:image'));

  // Prices
  const cleanPrice = s => {
    const m = (s || '').match(/\$([\d,]+\.\d{2})/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  };
  const salesTxt = $el.find('.price .sales, .price .value').first().text();
  const strikeTxt = $el.find('.price .strike-through, .price .list').first().text();
  const sales = cleanPrice(salesTxt);
  const original = cleanPrice(strikeTxt);
  const price = sales || original || null;
  const oldPrice = original && sales && original > sales ? original : null;

  return {
    pid,
    masterProductId: ga?.masterProductId || pid,
    name,
    brand,
    color,
    category: line || productType,         // high-level (Shoes / Apparel)
    productType,                            // Running / Lifestyle / Training
    gender,
    imageUrl: primary,
    images,
    currencySymbol: '$',
    originalPrice: oldPrice || price,       // fallback to price if no sale
    promotionalPrice: oldPrice ? price : null,
    productUrl,
    sizes: [],                              // out of scope for v1
    source: 'joes',
  };
}

// Глобальный счётчик потраченных кредитов ScrapFly
let _spent = 0;
const COST_BUDGET = parseInt(process.env.COST_BUDGET || '500', 10);

async function scrapeCategory(cat) {
  const all = [];
  for (let page = 0; page < MAX_PAGES_PER_CAT; page++) {
    if (_spent >= COST_BUDGET) {
      console.log(`  ⚠️  budget exceeded (${_spent}/${COST_BUDGET}) — stopping ${cat.name}`);
      break;
    }
    const start = page * PAGE_SIZE;
    const url = `${BASE}${GRID}?cgid=${cat.cgid}&start=${start}&sz=${PAGE_SIZE}`;
    const r = await sfFetch(url);
    const html = r.data?.result?.content || '';
    const cost = r.data?.context?.cost?.total || 0;
    _spent += cost;

    const $ = cheerio.load(html);
    const tiles = $('.pgptiles').toArray();
    console.log(`  ${cat.name} page ${page+1} (start=${start}): ${tiles.length} tiles  cost ${cost}  spent ${_spent}`);
    if (tiles.length === 0) break;

    for (const t of tiles) {
      const p = parseTile($, t);
      if (p && p.originalPrice) all.push(p);
    }
    if (tiles.length < PAGE_SIZE) break; // last page
  }
  return all;
}

async function main() {
  // Step 1: discover missing cgids
  for (const cat of CATEGORIES) {
    if (!cat.cgid) cat.cgid = await discoverCgid(cat.path);
    if (!cat.cgid) console.error(`  ⚠️  cgid for ${cat.name} not found — skipping`);
  }

  // Step 2: scrape each
  const bucket = new Map(); // pid → product (dedupe)
  for (const cat of CATEGORIES) {
    if (!cat.cgid) continue;
    console.log(`\n=== ${cat.name} (cgid=${cat.cgid}) ===`);
    const items = await scrapeCategory(cat);
    for (const p of items) {
      if (!bucket.has(p.pid)) bucket.set(p.pid, p);
    }
    console.log(`  total unique so far: ${bucket.size}`);
  }

  const out = Array.from(bucket.values());
  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  console.log(`\n✅ Saved ${out.length} products → ${OUTPUT}`);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
