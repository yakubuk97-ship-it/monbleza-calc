const https = require('https');

const BOT_TOKEN = '8717339910:AAE14IK6Zd5bHgAAD3Tt6Rpm3JQsLZzuppE';
const OWNER_ID = 6156197177;
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

// Хранилище: chatId клиента → последнее сообщение (для ответов)
const clients = {};

require('http').createServer(async (req, res) => {
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
        // Владелец отвечает — пересылаем клиенту
        if (msg.reply_to_message) {
          // Ищем chatId клиента по тексту пересланного сообщения
          const replyText = msg.reply_to_message.text || '';
          const match = replyText.match(/ID: (\d+)/);
          if (match) {
            const clientId = parseInt(match[1]);
            await tgRequest('sendMessage', { chat_id: clientId, text });
            await tgRequest('sendMessage', { chat_id: OWNER_ID, text: '✅ Ответ отправлен' });
          }
        }
      } else {
        // Сообщение от клиента — пересылаем владельцу
        clients[chatId] = name;
        await tgRequest('sendMessage', {
          chat_id: OWNER_ID,
          text: `💬 Новое сообщение\n👤 ${name} (${username})\n🆔 ID: ${chatId}\n\n${text}\n\n↩️ Ответь на это сообщение чтобы написать клиенту`
        });
        // Автоответ клиенту
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
