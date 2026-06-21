require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
const ADMIN_PASSWORDS = [
  process.env.ADMIN_PASS_1 || 'RedAdmin_2024',
  process.env.ADMIN_PASS_2 || 'RedShop_Boss'
];

// ─── Data helpers ────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');

function readJSON(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return file.endsWith('messages.json') ? {} : [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return file.endsWith('messages.json') ? {} : []; }
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf8');
}

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const uploadsDir = path.join(__dirname, 'public', 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  if (!fs.existsSync(path.join(DATA_DIR, 'products.json'))) {
    writeJSON('products.json', defaultProducts());
  }
  if (!fs.existsSync(path.join(DATA_DIR, 'orders.json'))) writeJSON('orders.json', []);
  if (!fs.existsSync(path.join(DATA_DIR, 'users.json'))) writeJSON('users.json', []);
  if (!fs.existsSync(path.join(DATA_DIR, 'messages.json'))) writeJSON('messages.json', {});
}

function defaultProducts() {
  return [
    { id: 1, name: 'Watermelon Ice', price: 350, photo: '/img/placeholder.svg', available: true, sales: 0, description: 'Арбуз со льдом' },
    { id: 2, name: 'Mango Peach', price: 350, photo: '/img/placeholder.svg', available: true, sales: 0, description: 'Манго и персик' },
    { id: 3, name: 'Blueberry Ice', price: 380, photo: '/img/placeholder.svg', available: true, sales: 0, description: 'Черника со льдом' },
    { id: 4, name: 'Strawberry Kiwi', price: 350, photo: '/img/placeholder.svg', available: true, sales: 0, description: 'Клубника и киви' },
    { id: 5, name: 'Lychee Ice', price: 400, photo: '/img/placeholder.svg', available: true, sales: 0, description: 'Личи со льдом' },
    { id: 6, name: 'Grape Ice', price: 350, photo: '/img/placeholder.svg', available: false, sales: 0, description: 'Виноград со льдом' },
  ];
}

// ─── Telegram initData verification ──────────────────────────────────────────

function verifyTelegramInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash || !BOT_TOKEN || BOT_TOKEN === 'your_bot_token_here') return false;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return calculatedHash === hash;
  } catch { return false; }
}

// ─── Set bot menu button ──────────────────────────────────────────────────────

function setBotMenuButton() {
  if (!BOT_TOKEN || BOT_TOKEN === 'your_bot_token_here') return;
  const body = JSON.stringify({
    menu_button: {
      type: 'web_app',
      text: '🛍 Открыть магазин',
      web_app: { url: WEBAPP_URL }
    }
  });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/setChatMenuButton`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = https.request(options, res => {
    let data = '';
    res.on('data', d => data += d);
    res.on('end', () => {
      try {
        const result = JSON.parse(data);
        if (result.ok) console.log('✅ Кнопка меню бота установлена →', WEBAPP_URL);
        else console.warn('⚠️  Кнопка меню:', result.description);
      } catch {}
    });
  });
  req.on('error', err => console.warn('⚠️  setBotMenuButton:', err.message));
  req.write(body);
  req.end();
}

// ─── Multer (file uploads) ────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `product_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Только изображения'));
  }
});

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Admin auth middleware — принимает: пароль (legacy), Telegram initData (основной), userId (dev)
function requireAdmin(req, res, next) {
  // 1. Legacy password (backward compat)
  const pass = req.headers['x-admin-password'];
  if (pass && ADMIN_PASSWORDS.includes(pass)) return next();

  // 2. Telegram initData (cryptographic verification)
  const initData = req.headers['x-telegram-init-data'];
  if (initData && verifyTelegramInitData(initData)) {
    try {
      const params = new URLSearchParams(initData);
      const user = JSON.parse(decodeURIComponent(params.get('user') || '{}'));
      if (ADMIN_IDS.includes(user.id)) return next();
    } catch {}
  }

  // 3. Simple userId header (for dev/non-TG context when initData not available)
  const userId = parseInt(req.headers['x-admin-userid'] || '0');
  if (!isNaN(userId) && userId > 0 && ADMIN_IDS.includes(userId)) return next();

  res.status(401).json({ error: 'Unauthorized' });
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Auth (legacy password)
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (ADMIN_PASSWORDS.includes(password)) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Неверный пароль' });
  }
});

// Check admin by Telegram ID / initData
app.get('/api/check-admin', (req, res) => {
  const userId = parseInt(req.query.userId || '0');
  if (!isNaN(userId) && userId > 0 && ADMIN_IDS.includes(userId)) {
    return res.json({ isAdmin: true });
  }
  res.json({ isAdmin: false });
});

// Check admin via initData (POST, cryptographically verified)
app.post('/api/check-admin', (req, res) => {
  const { initData } = req.body;
  if (initData && verifyTelegramInitData(initData)) {
    try {
      const params = new URLSearchParams(initData);
      const user = JSON.parse(decodeURIComponent(params.get('user') || '{}'));
      if (ADMIN_IDS.includes(user.id)) return res.json({ isAdmin: true, userId: user.id });
    } catch {}
  }
  res.json({ isAdmin: false });
});

// Products (public)
app.get('/api/products', (req, res) => {
  res.json(readJSON('products.json'));
});

// Products (admin)
app.post('/api/products', requireAdmin, upload.single('photo'), (req, res) => {
  const products = readJSON('products.json');
  const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
  const product = {
    id: newId,
    name: req.body.name,
    price: parseInt(req.body.price),
    photo: req.file ? `/uploads/${req.file.filename}` : '/img/placeholder.svg',
    available: true,
    sales: 0,
    description: req.body.description || ''
  };
  products.push(product);
  writeJSON('products.json', products);
  res.json(product);
});

app.put('/api/products/:id', requireAdmin, upload.single('photo'), (req, res) => {
  const products = readJSON('products.json');
  const idx = products.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });

  if (req.body.name !== undefined) products[idx].name = req.body.name;
  if (req.body.price !== undefined) products[idx].price = parseInt(req.body.price);
  if (req.body.available !== undefined) products[idx].available = req.body.available === 'true' || req.body.available === true;
  if (req.body.description !== undefined) products[idx].description = req.body.description;
  if (req.file) products[idx].photo = `/uploads/${req.file.filename}`;

  writeJSON('products.json', products);
  res.json(products[idx]);
});

app.delete('/api/products/:id', requireAdmin, (req, res) => {
  const products = readJSON('products.json');
  const filtered = products.filter(p => p.id !== parseInt(req.params.id));
  writeJSON('products.json', filtered);
  res.json({ ok: true });
});

// Orders
app.get('/api/orders', requireAdmin, (req, res) => {
  const orders = readJSON('orders.json');
  res.json(orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/orders', (req, res) => {
  const orders = readJSON('orders.json');
  const order = {
    id: Date.now(),
    ...req.body,
    status: 'new',
    createdAt: new Date().toISOString()
  };
  orders.push(order);
  writeJSON('orders.json', orders);

  // Update product sales
  const products = readJSON('products.json');
  (order.items || []).forEach(item => {
    const prod = products.find(p => p.id === item.id);
    if (prod) prod.sales = (prod.sales || 0) + (item.qty || 1);
  });
  writeJSON('products.json', products);

  // Notify admins via bot
  if (bot) {
    const text = `🆕 *Новый заказ #${order.id}*\n` +
      `👤 ${order.userName || 'Аноним'}\n` +
      `📦 ${(order.items || []).map(i => `${i.name} ×${i.qty}`).join('\n')}\n` +
      `💰 Сумма: ${order.total} сом\n` +
      (order.discount ? `🎁 Скидка: −${order.discount} сом\n` : '') +
      `✅ Итого: *${order.finalTotal} сом*`;
    ADMIN_IDS.forEach(id => bot.sendMessage(id, text, { parse_mode: 'Markdown' }).catch(() => {}));
  }

  res.json(order);
});

app.put('/api/orders/:id/status', requireAdmin, (req, res) => {
  const orders = readJSON('orders.json');
  const order = orders.find(o => o.id === parseInt(req.params.id));
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });
  order.status = req.body.status;
  writeJSON('orders.json', orders);

  // Notify customer
  if (bot && order.userId) {
    const labels = { processing: 'В обработке ⏳', done: 'Выполнен ✅', new: 'Новый 🆕' };
    bot.sendMessage(order.userId, `Статус вашего заказа #${order.id} изменён: ${labels[order.status] || order.status}`).catch(() => {});
  }

  res.json(order);
});

// Messages
app.get('/api/messages', requireAdmin, (req, res) => {
  const messages = readJSON('messages.json');
  const users = readJSON('users.json');
  // Build list with user info
  const result = Object.entries(messages).map(([userId, msgs]) => {
    const user = users.find(u => u.id === parseInt(userId)) || { id: parseInt(userId), firstName: userId };
    return { userId: parseInt(userId), user, messages: msgs, lastMessage: msgs[msgs.length - 1] };
  });
  res.json(result);
});

app.get('/api/messages/:userId', requireAdmin, (req, res) => {
  const messages = readJSON('messages.json');
  res.json(messages[req.params.userId] || []);
});

app.post('/api/messages/send', requireAdmin, (req, res) => {
  const { userId, text } = req.body;
  if (!userId || !text) return res.status(400).json({ error: 'userId и text обязательны' });

  const messages = readJSON('messages.json');
  if (!messages[userId]) messages[userId] = [];
  messages[userId].push({ from: 'admin', text, timestamp: new Date().toISOString() });
  writeJSON('messages.json', messages);

  // Send via bot
  if (bot) {
    bot.sendMessage(userId, text).catch(err => {
      console.error('Ошибка отправки сообщения:', err.message);
    });
  }

  res.json({ ok: true });
});

// Broadcast
app.post('/api/broadcast', requireAdmin, upload.single('photo'), async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Текст обязателен' });

  const users = readJSON('users.json');
  let sent = 0, failed = 0;

  for (const user of users) {
    try {
      if (req.file) {
        await bot.sendPhoto(user.id, path.join(__dirname, 'public', 'uploads', req.file.filename), { caption: text });
      } else {
        await bot.sendMessage(user.id, text);
      }
      sent++;
      await new Promise(r => setTimeout(r, 50)); // rate limit
    } catch {
      failed++;
    }
  }

  res.json({ ok: true, sent, failed, total: users.length });
});

// Stats
app.get('/api/stats', requireAdmin, (req, res) => {
  const users = readJSON('users.json');
  const orders = readJSON('orders.json');
  const products = readJSON('products.json');

  const today = new Date().toDateString();
  const todayOrders = orders.filter(o => new Date(o.createdAt).toDateString() === today);
  const todaySales = todayOrders.reduce((sum, o) => sum + (o.finalTotal || 0), 0);

  // Most popular product
  const topProduct = [...products].sort((a, b) => (b.sales || 0) - (a.sales || 0))[0];

  res.json({
    totalUsers: users.length,
    totalOrders: orders.length,
    todayOrders: todayOrders.length,
    todaySales,
    topProduct: topProduct ? { name: topProduct.name, sales: topProduct.sales } : null,
    availableProducts: products.filter(p => p.available).length,
    totalProducts: products.length
  });
});

// Users (for messages dropdown)
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(readJSON('users.json'));
});

// ─── Telegram Bot ─────────────────────────────────────────────────────────────

let bot = null;

function initBot() {
  if (!BOT_TOKEN || BOT_TOKEN === 'your_bot_token_here') {
    console.warn('⚠️  BOT_TOKEN не задан. Бот не запущен. Установите его в .env файле.');
    return;
  }

  try {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });

    bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const user = msg.from;

      // Register/update user
      const users = readJSON('users.json');
      const existing = users.find(u => u.id === userId);
      if (!existing) {
        users.push({
          id: userId,
          username: user.username || '',
          firstName: user.first_name || '',
          lastName: user.last_name || '',
          firstSeen: new Date().toISOString()
        });
        writeJSON('users.json', users);
      }

      // Handle /start
      if (msg.text === '/start') {
        bot.sendMessage(chatId,
          '🔴 *Добро пожаловать в Red Shop!*\n\nОдноразовые сигареты премиум качества.\nЛучшие вкусы по лучшим ценам! 💨',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '🛍️ Открыть магазин', web_app: { url: WEBAPP_URL } }
              ]]
            }
          }
        );
        return;
      }

      // Handle web_app_data (order from Mini App)
      if (msg.web_app_data) {
        try {
          const orderData = JSON.parse(msg.web_app_data.data);
          const orders = readJSON('orders.json');
          const order = {
            id: Date.now(),
            userId,
            userName: `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.username || String(userId),
            username: user.username || '',
            ...orderData,
            status: 'new',
            createdAt: new Date().toISOString()
          };
          orders.push(order);
          writeJSON('orders.json', orders);

          // Update sales
          const products = readJSON('products.json');
          (order.items || []).forEach(item => {
            const prod = products.find(p => p.id === item.id);
            if (prod) prod.sales = (prod.sales || 0) + (item.qty || 1);
          });
          writeJSON('products.json', products);

          bot.sendMessage(chatId,
            `✅ *Заказ #${order.id} принят!*\n\n` +
            `📦 ${(order.items || []).map(i => `${i.name} ×${i.qty} — ${i.price * i.qty} сом`).join('\n')}\n` +
            (order.discount ? `🎁 Скидка: −${order.discount} сом\n` : '') +
            `\n💰 Итого: *${order.finalTotal} сом*\n\nМы свяжемся с вами в ближайшее время!`,
            { parse_mode: 'Markdown' }
          );

          // Notify admins
          const adminText = `🆕 *Новый заказ #${order.id}*\n` +
            `👤 ${order.userName}${order.username ? ` (@${order.username})` : ''}\n\n` +
            `📦 Состав:\n${(order.items || []).map(i => `• ${i.name} ×${i.qty} — ${i.price * i.qty} сом`).join('\n')}\n\n` +
            (order.discount ? `🎁 Скидка: −${order.discount} сом\n` : '') +
            `💰 Итого: *${order.finalTotal} сом*`;
          ADMIN_IDS.forEach(id => bot.sendMessage(id, adminText, { parse_mode: 'Markdown' }).catch(() => {}));
        } catch (e) {
          console.error('Ошибка обработки заказа:', e);
        }
        return;
      }

      // Save regular message
      if (msg.text) {
        const messages = readJSON('messages.json');
        if (!messages[userId]) messages[userId] = [];
        messages[userId].push({
          from: 'user',
          text: msg.text,
          timestamp: new Date().toISOString(),
          userName: `${user.first_name || ''}`.trim()
        });
        writeJSON('messages.json', messages);

        // Notify admins
        const notifyText = `💬 Сообщение от *${user.first_name || userId}*${user.username ? ` (@${user.username})` : ''}:\n\n${msg.text}`;
        ADMIN_IDS.forEach(id => bot.sendMessage(id, notifyText, { parse_mode: 'Markdown' }).catch(() => {}));

        // Auto-reply
        bot.sendMessage(chatId, 'Ваше сообщение получено! Администратор ответит вам в ближайшее время. 😊');
      }
    });

    bot.on('polling_error', (err) => {
      console.error('Bot polling error:', err.message);
    });

    // Set menu button to open Mini App
    setBotMenuButton();

    console.log('✅ Telegram бот запущен');
  } catch (err) {
    console.error('Ошибка запуска бота:', err.message);
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────

ensureDataFiles();
initBot();

app.listen(PORT, () => {
  console.log(`🚀 Red Shop сервер запущен на порту ${PORT}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`📱 Mini App: ${WEBAPP_URL}`);
});
