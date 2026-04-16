const https = require('https');
const http = require('http');

const BOT_TOKEN = '8717339910:AAE14IK6Zd5bHgAAD3Tt6Rpm3JQsLZzuppE';
const OWNER_ID = 6156197177;
const MS_TOKEN = '3b701e01c5660188053b898da86779c282b1c527';
const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = 'yakubuk97-ship-it/monbleza-calc';
const GITHUB_WORKFLOW = 'update-stock.yml';

function tgRequest(method, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function msRequest(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.moysklad.ru',
      path: '/api/remap/1.2' + path,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + MS_TOKEN, 'Accept': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Кэш товаров (обновляем раз в 10 минут)
let stockCache = null;
let stockCacheTime = 0;

async function getStock() {
  if (stockCache && Date.now() - stockCacheTime < 10 * 60 * 1000) return stockCache;

  // Берём остатки (только где quantity > 0)
  const report = await msRequest('/report/stock/all?filter=stockMode%3DpositiveOnly&limit=100');
  const rows = report.rows || [];

  const items = await Promise.all(rows.map(async row => {
    // Получаем фото товара
    let img = '';
    try {
      const productId = row.meta.href.split('/entity/')[1];
      // productId = "product/UUID" or "variant/UUID"
      const type = productId.split('/')[0];
      const id = productId.split('/')[1];
      const imgData = await msRequest(`/entity/${type}/${id}/images?limit=1`);
      if (imgData.rows && imgData.rows[0]) {
        img = imgData.rows[0].meta.downloadHref + '?miniature=true';
      }
    } catch(e) {}

    const price = row.salePrice ? row.salePrice / 100 : 0;
    // Парсим категорию из pathName
    const pathParts = (row.pathName || '').split('/');
    const category = pathParts[pathParts.length - 1] || '';

    return {
      id: row.meta.href,
      name: row.name,
      brand: extractBrand(row.name),
      price,
      quantity: row.quantity || 0,
      size: row.size || '',
      category,
      img
    };
  }));

  stockCache = items.filter(i => i.price > 0);
  stockCacheTime = Date.now();
  return stockCache;
}

function extractBrand(name) {
  const brands = ['Nike','Adidas','New Balance','Puma','Converse','Vans','The North Face',
    'Tommy Hilfiger','Calvin Klein','Ralph Lauren','Hugo Boss','Lacoste','Fred Perry',
    'Levi\'s','Diesel','Birkenstock','UGG','Dr. Martens','Gant','Weekend Offender',
    'Columbia','Helly Hansen','Under Armour','Jack Wolfskin','Polo'];
  for (const b of brands) {
    if (name.toLowerCase().includes(b.toLowerCase())) return b;
  }
  // Берём первое слово как бренд
  return name.split(' ')[0];
}

const clients = {};

http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Пинг — чтобы сервер не засыпал
  if (req.url === '/ping') { res.writeHead(200); res.end('ok'); return; }

  // Вебхук от МоегоСклада — обновление остатков
  if (req.method === 'POST' && req.url === '/webhook/stock') {
    res.writeHead(200); res.end('ok'); // сразу отвечаем МойСкладу
    if (!GITHUB_TOKEN) { console.log('GITHUB_TOKEN не задан'); return; }
    // Запускаем GitHub Actions workflow
    const body = JSON.stringify({ ref: 'main' });
    const ghReq = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
      method: 'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'monbleza-bot'
      }
    }, r => console.log('GitHub Actions triggered:', r.statusCode));
    ghReq.on('error', e => console.error('GitHub trigger error:', e.message));
    ghReq.write(body); ghReq.end();
    console.log('Webhook received from MoySklad — triggering update');
    return;
  }

  // Прокси для фото МойСклад (добавляет Bearer токен)
  if (req.method === 'GET' && req.url.startsWith('/img?')) {
    const imgUrl = new URL('http://x' + req.url).searchParams.get('url');
    if (!imgUrl || !imgUrl.startsWith('https://api.moysklad.ru/')) {
      res.writeHead(400); res.end(); return;
    }
    const proxyReq = https.request(imgUrl, { headers: { 'Authorization': 'Bearer ' + MS_TOKEN } }, proxyRes => {
      res.writeHead(200, {
        'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg',
        'Cache-Control': 'public, max-age=604800',
        'Access-Control-Allow-Origin': '*'
      });
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => { res.writeHead(502); res.end(); });
    proxyReq.end();
    return;
  }

  // СДЭК ПВЗ прокси (v2 API)
  if (req.method === 'GET' && req.url.startsWith('/cdek-pvz')) {
    const params = new URL('http://x' + req.url).searchParams;
    const city = params.get('city') || 'Москва';
    try {
      const axios = require('axios');
      // Получаем токен
      const tokenRes = await axios.post(
        'https://api.cdek.ru/v2/oauth/token',
        'grant_type=client_credentials&client_id=EMscd6r9JnFiQ3bLoyjJY6eM78JrJceI&client_secret=PjLZkKBHEiLK3YsjtNrt3TGNG0ahs3kG',
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const token = tokenRes.data.access_token;
      // Получаем код города
      const cityRes = await axios.get(
        `https://api.cdek.ru/v2/location/cities?city=${encodeURIComponent(city)}&size=1`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const cities = cityRes.data;
      if (!cities || !cities.length) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ pvz: [] }));
        return;
      }
      const cityCode = cities[0].code;
      // Получаем ПВЗ
      const pvzRes = await axios.get(
        `https://api.cdek.ru/v2/deliverypoints?city_code=${cityCode}&type=PVZ&size=200`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const pvz = (pvzRes.data || []).map(p => ({
        Code: p.code,
        Name: p.name || '',
        Address: (p.location && p.location.address) || '',
        FullAddress: `${(p.location && p.location.city) || city}, ${(p.location && p.location.address) || ''}`,
        coordX: p.location && p.location.longitude,
        coordY: p.location && p.location.latitude,
        WorkTime: p.work_time || '',
      }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ pvz }));
    } catch(e) {
      console.error('CDEK error:', e.message);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ pvz: [], error: e.message }));
    }
    return;
  }

  // Keep-alive ping (для UptimeRobot)
  if (req.url === '/ping') {
    res.setHeader('Content-Type', 'text/plain');
    res.end('ok');
    return;
  }

  // Эндпоинт для товаров из МойСклад
  if (req.method === 'GET' && req.url === '/stock') {
    try {
      const items = await getStock();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(items));
    } catch(e) {
      console.error('Stock error:', e);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method !== 'POST') { res.end('ok'); return; }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      const update = JSON.parse(body);
      const msg = update.message;
      if (!msg) { res.end('ok'); return; }

      const chatId = msg.chat.id;
      const text = msg.text || '[медиа/файл]';
      const from = msg.from;
      const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
      const username = from.username ? `@${from.username}` : 'без username';

      if (chatId === OWNER_ID) {
        if (msg.reply_to_message) {
          const replyText = msg.reply_to_message.text || '';
          const match = replyText.match(/ID: (\d+)/);
          if (match) {
            const clientId = parseInt(match[1]);
            await tgRequest('sendMessage', { chat_id: clientId, text });
            await tgRequest('sendMessage', { chat_id: OWNER_ID, text: '✅ Ответ отправлен' });
          }
        }
      } else {
        clients[chatId] = name;
        await tgRequest('sendMessage', {
          chat_id: OWNER_ID,
          text: `💬 Новое сообщение\n👤 ${name} (${username})\n🆔 ID: ${chatId}\n\n${text}\n\n↩️ Ответь на это сообщение чтобы написать клиенту`
        });
        await tgRequest('sendMessage', {
          chat_id: chatId,
          text: '👋 Привет! Мы получили твоё сообщение и скоро ответим.\n\nА пока — смотри каталог 👇',
          reply_markup: {
            inline_keyboard: [[{ text: '🛍 Открыть каталог', web_app: { url: 'https://yakubuk97-ship-it.github.io/monbleza-calc' } }]]
          }
        });
      }
    } catch(e) { console.error(e); }
    res.end('ok');
  });
}).listen(PORT, () => console.log(`Bot server running on port ${PORT}`));
