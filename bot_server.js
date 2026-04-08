const https = require('https');
const http = require('http');

const BOT_TOKEN = '8717339910:AAE14IK6Zd5bHgAAD3Tt6Rpm3JQsLZzuppE';
const OWNER_ID = 6156197177;
const MS_TOKEN = '3b701e01c5660188053b898da86779c282b1c527';
const PORT = process.env.PORT || 3000;

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

  // СДЭК ПВЗ прокси
  if (req.method === 'GET' && req.url.startsWith('/cdek-pvz')) {
    const params = new URL('http://x' + req.url).searchParams;
    const city = params.get('city') || 'Москва';
    const pvzReq = https.request({
      hostname: 'integration.cdek.ru',
      path: '/pvzlist/v1/json?type=PVZ&city=' + encodeURIComponent(city),
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }, pvzRes => {
      res.setHeader('Content-Type', 'application/json');
      pvzRes.pipe(res);
    });
    pvzReq.on('error', () => { res.writeHead(502); res.end('{}'); });
    pvzReq.end();
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
