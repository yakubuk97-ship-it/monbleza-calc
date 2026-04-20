#!/usr/bin/env node
// Собрать joes_data.json из уже скачанного joes_grid_200.html (0 кредитов).
const fs = require('fs');
const cheerio = require('cheerio');
const BASE = 'https://www.joesnewbalanceoutlet.com';

function parseTile($, el) {
  const $el = $(el);
  const pid = $el.find('[data-pid]').first().attr('data-pid') || '';
  if (!pid) return null;
  let ga = null;
  const gaAttr = $el.find('[data-tealium-product-tile-data]').first().attr('data-tealium-product-tile-data');
  if (gaAttr) { try { ga = JSON.parse(gaAttr); } catch (e) {} }

  const name = (ga && ga.productName) || '';
  const brand = (ga && ga.brand) || 'New Balance';
  const color = (ga && ga.color) || '';
  const productType = (ga && (ga.productType || ga.productGbu)) || '';
  const line = (ga && ga.line) || '';
  const gender = (ga && ga.gender) || '';

  const href = $el.find('a.tile-link, a[href*="/pd/"]').first().attr('href') || '';
  const productUrl = href.startsWith('http') ? href : (BASE + href);

  const collectImg = (sel) => {
    const img = $el.find(sel).first();
    return img.attr('data-src') || img.attr('src') || '';
  };
  const primary = collectImg('picture.firstImage img, picture.main-image img');
  const hover = collectImg('picture.nextImage img, picture.next-main-image img');
  const images = [primary, hover].filter(u => u && !u.startsWith('data:image'));

  const cleanPrice = s => {
    const m = (s || '').match(/\$([\d,]+\.\d{2})/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  };
  const sales = cleanPrice($el.find('.price .sales, .price .value').first().text());
  const original = cleanPrice($el.find('.price .strike-through, .price .list').first().text());
  const price = sales || original || null;
  const oldPrice = original && sales && original > sales ? original : null;
  if (!price) return null;

  return {
    pid,
    masterProductId: ga?.masterProductId || pid,
    name, brand, color,
    category: line || productType,
    productType, gender,
    imageUrl: primary,
    images,
    currencySymbol: '$',
    originalPrice: oldPrice || price,
    promotionalPrice: oldPrice ? price : null,
    productUrl,
    sizes: [],
    source: 'joes',
  };
}

const html = fs.readFileSync('joes_grid_200.html', 'utf8');
const $ = cheerio.load(html);
const out = [];
const seen = new Set();
for (const el of $('.pgptiles').toArray()) {
  const p = parseTile($, el);
  if (p && !seen.has(p.pid)) { seen.add(p.pid); out.push(p); }
}
fs.writeFileSync('joes_data.json', JSON.stringify(out, null, 2));
console.log(`✅ Saved ${out.length} products → joes_data.json (0 credits)`);
