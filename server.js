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

  // Восстановить products.json если файл отсутствует или пустой/сломан
  const productsPath = path.join(DATA_DIR, 'products.json');
  let needsDefault = false;
  if (!fs.existsSync(productsPath)) {
    needsDefault = true;
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
      if (!Array.isArray(parsed) || parsed.length === 0) needsDefault = true;
    } catch { needsDefault = true; }
  }
  if (needsDefault) writeJSON('products.json', defaultProducts());

  if (!fs.existsSync(path.join(DATA_DIR, 'categories.json'))) {
    writeJSON('categories.json', defaultCategories());
  }

  migrateProductsCategory();

  if (!fs.existsSync(path.join(DATA_DIR, 'orders.json'))) writeJSON('orders.json', []);
  if (!fs.existsSync(path.join(DATA_DIR, 'users.json'))) writeJSON('users.json', []);
  if (!fs.existsSync(path.join(DATA_DIR, 'messages.json'))) writeJSON('messages.json', {});
}

function defaultCategories() {
  return [
    { id: 1, name: 'Waka', photo: '/img/placeholder.svg' },
    { id: 2, name: 'Elf Bar', photo: '/img/placeholder.svg' },
    { id: 3, name: 'Ева', photo: '/img/placeholder.svg' }
  ];
}

function migrateProductsCategory() {
  const categories = readJSON('categories.json');
  const defaultCatId = categories.length > 0 ? categories[0].id : 1;
  const products = readJSON('products.json');
  if (!Array.isArray(products)) return;
  let changed = false;
  products.forEach(p => {
    if (!p.categoryId) {
      p.categoryId = defaultCatId;
      changed = true;
    }
  });
  if (changed) writeJSON('products.json', products);
}

function defaultProducts() {
  return [
    { id: 1, name: 'Watermelon Ice', price: 350, categoryId: 1, photo: '/img/placeholder.svg', available: true, sales: 0, description: 'Арбуз со льдом' },
    { id: 2, name: 'Mango Peach', price: 350, categoryId: 1, photo: '/img/placeholder.svg', available: true, sales: 0, description: 'Манго и персик' },
    { id: 3, name: 'Blueberry Ice', price: 380, categoryId: 1, photo: '/img/placeholder.svg', available: true, sales: 0, description: 'Черника со льдом' },
    { id: 4, name: 'Strawberry Kiwi', price: 350, categoryId: 1, photo: '/img/placeholder.svg', available: true, sales: 0, description: 'Клубника и киви' },
    { id: 5, name: 'Lychee Ice', price: 400, categoryId: 1, photo: '/img/placeholder.svg', available: true, sales: 0, description: 'Личи со льдом' },
    { id: 6, name: 'Grape Ice', price: 350, categoryId: 1, photo: '/img/placeholder.svg', available: false, sales: 0, description: 'Виноград со льдом' },
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

function getVerifiedTelegramUserId(initData) {
  if (!initData || !verifyTelegramInitData(initData)) return null;
  try {
    const params = new URLSearchParams(initData);
    const user = JSON.parse(decodeURIComponent(params.get('user') || '{}'));
    return user.id || null;
  } catch { return null; }
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
    const prefix = req.originalUrl.includes('/categories') ? 'category' : 'product';
    cb(null, `${prefix}_${Date.now()}${ext}`);
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

// Categories (public read)
app.get('/api/categories', (req, res) => {
  res.json(readJSON('categories.json'));
});

app.post('/api/categories', requireAdmin, upload.single('photo'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название позиции' });
  const categories = readJSON('categories.json');
  const newId = categories.length > 0 ? Math.max(...categories.map(c => c.id)) + 1 : 1;
  const category = {
    id: newId,
    name,
    photo: req.file ? `/uploads/${req.file.filename}` : '/img/placeholder.svg'
  };
  categories.push(category);
  writeJSON('categories.json', categories);
  res.json(category);
});

app.put('/api/categories/:id', requireAdmin, upload.single('photo'), (req, res) => {
  const categories = readJSON('categories.json');
  const idx = categories.findIndex(c => c.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Позиция не найдена' });
  if (req.body.name !== undefined) {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Укажите название позиции' });
    categories[idx].name = name;
  }
  if (req.file) categories[idx].photo = `/uploads/${req.file.filename}`;
  writeJSON('categories.json', categories);
  res.json(categories[idx]);
});

app.delete('/api/categories/:id', requireAdmin, (req, res) => {
  const catId = parseInt(req.params.id);
  const products = readJSON('products.json');
  const inCategory = products.filter(p => p.categoryId === catId);
  if (inCategory.length > 0) {
    return res.status(400).json({
      error: `Нельзя удалить: в позиции ${inCategory.length} товар(ов). Сначала удалите или перенесите их.`
    });
  }
  const categories = readJSON('categories.json');
  const filtered = categories.filter(c => c.id !== catId);
  if (filtered.length === categories.length) return res.status(404).json({ error: 'Позиция не найдена' });
  writeJSON('categories.json', filtered);
  res.json({ ok: true });
});

// Products (public)
app.get('/api/products', (req, res) => {
  res.json(readJSON('products.json'));
});

// Products (admin)
app.post('/api/products', requireAdmin, upload.single('photo'), (req, res) => {
  const products = readJSON('products.json');
  const categories = readJSON('categories.json');
  const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
  const defaultCatId = categories.length > 0 ? categories[0].id : 1;
  let categoryId = parseInt(req.body.categoryId);
  if (isNaN(categoryId) || !categories.some(c => c.id === categoryId)) categoryId = defaultCatId;
  const oldPriceRaw = req.body.oldPrice;
  const oldPrice = oldPriceRaw !== undefined && oldPriceRaw !== '' ? parseInt(oldPriceRaw) : null;
  const product = {
    id: newId,
    name: req.body.name,
    price: parseInt(req.body.price),
    categoryId,
    photo: req.file ? `/uploads/${req.file.filename}` : '/img/placeholder.svg',
    available: true,
    sales: 0,
    description: req.body.description || ''
  };
  if (oldPrice && oldPrice > product.price) product.oldPrice = oldPrice;
  products.push(product);
  writeJSON('products.json', products);
  res.json(product);
});

app.put('/api/products/:id', requireAdmin, upload.single('photo'), (req, res) => {
  const products = readJSON('products.json');
  const categories = readJSON('categories.json');
  const idx = products.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });

  if (req.body.name !== undefined) products[idx].name = req.body.name;
  if (req.body.price !== undefined) products[idx].price = parseInt(req.body.price);
  if (req.body.available !== undefined) products[idx].available = req.body.available === 'true' || req.body.available === true;
  if (req.body.description !== undefined) products[idx].description = req.body.description;
  if (req.body.categoryId !== undefined) {
    const categoryId = parseInt(req.body.categoryId);
    if (!isNaN(categoryId) && categories.some(c => c.id === categoryId)) {
      products[idx].categoryId = categoryId;
    }
  }
  if (req.body.oldPrice !== undefined) {
    const oldPrice = req.body.oldPrice === '' || req.body.oldPrice === null ? null : parseInt(req.body.oldPrice);
    if (oldPrice && oldPrice > products[idx].price) products[idx].oldPrice = oldPrice;
    else delete products[idx].oldPrice;
  }
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

app.get('/api/orders/my', (req, res) => {
  const verifiedUserId = getVerifiedTelegramUserId(req.headers['x-telegram-init-data']);
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const orders = readJSON('orders.json');
  const mine = orders
    .filter(o => Number(o.userId) === Number(verifiedUserId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(mine);
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
    const itemLines = (order.items || []).map(i => {
      const pos = i.categoryName || order.categoryName || '';
      const flavor = i.description || i.name;
      return pos ? `• ${pos} — ${flavor} ×${i.qty || 1}` : `• ${flavor} ×${i.qty || 1}`;
    }).join('\n');
    let text = `🆕 *Новый заказ #${order.id}*\n` +
      `👤 ${order.userName || 'Аноним'}${order.username ? ` (@${order.username})` : ''}\n\n` +
      `📦 ${itemLines}\n`;
    if (order.phone) text += `\n📞 ${order.phone}`;
    if (order.address) text += `\n📍 ${order.address}`;
    if (order.comment) text += `\n💬 ${order.comment}`;
    text += `\n\n💰 Сумма: ${order.total || order.finalTotal} сом\n`;
    if (order.discount) text += `🎁 Скидка: −${order.discount} сом\n`;
    text += `✅ Итого: *${order.finalTotal} сом*`;
    ADMIN_IDS.forEach(id => bot.sendMessage(id, text, { parse_mode: 'Markdown' }).catch(() => {}));
  }

  if (bot && order.userId) {
    sendWelcomeMessage(order.userId).catch(() => {});
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
let botRestartTimer = null;

const WELCOME_TEXT =
  'Добро пожаловать в Red Shop! 🛒\n' +
  'Как заказать:\n' +
  '1. Выбери устройство и вкус в приложении\n' +
  '2. Нажми «Купить»\n' +
  '3. Укажи телефон и адрес\n\n' +
  'Заказ оформляется здесь, в боте.\n' +
  'Если есть вопросы — напиши менеджеру 👇';

function getWelcomeKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛍️ Открыть магазин', web_app: { url: WEBAPP_URL } }],
        [{ text: '💬 Написать менеджеру', url: 'https://t.me/roomsellerr' }]
      ]
    }
  };
}

function sendWelcomeMessage(chatId) {
  if (!bot) return Promise.resolve();
  return bot.sendMessage(chatId, WELCOME_TEXT, getWelcomeKeyboard());
}

function isStartCommand(text) {
  if (!text || typeof text !== 'string') return false;
  const cmd = text.trim().split(/\s+/)[0].split('@')[0];
  return cmd === '/start';
}

// Сбрасывает pending updates чтобы убрать конфликтующий polling другого экземпляра
function clearPendingUpdates() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ timeout: 0, offset: -1 });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/getUpdates`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', () => resolve());
    req.setTimeout(5000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

async function initBot(retryCount = 0) {
  if (!BOT_TOKEN || BOT_TOKEN === 'your_bot_token_here') {
    console.warn('⚠️  BOT_TOKEN не задан. Бот не запущен. Установите его в .env файле.');
    return;
  }

  // Остановить предыдущий экземпляр если есть
  if (bot) {
    try { await bot.stopPolling(); } catch {}
    bot = null;
  }

  // Сбросить накопившиеся updates (освобождает сессию от конкурирующего polling)
  await clearPendingUpdates();
  await new Promise(r => setTimeout(r, 1500));

  try {
    bot = new TelegramBot(BOT_TOKEN, {
      polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10 }
      }
    });

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

      // Handle /start (включая /start welcome при переходе из Mini App)
      if (isStartCommand(msg.text)) {
        await sendWelcomeMessage(chatId);
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

    bot.on('polling_error', async (err) => {
      const code = err.code || (err.response && err.response.statusCode);

      // 409 Conflict — другой экземпляр бота уже ведёт polling
      if (code === 409 || String(err.message).includes('409')) {
        const delay = Math.min(5000 + retryCount * 5000, 60000);
        console.warn(`⚠️  Бот: 409 Conflict — другой экземпляр активен. Перезапуск через ${delay / 1000}с...`);
        try { await bot.stopPolling(); } catch {}
        bot = null;
        clearTimeout(botRestartTimer);
        botRestartTimer = setTimeout(() => initBot(retryCount + 1), delay);
        return;
      }

      // 401 Unauthorized — неверный токен, не перезапускать
      if (code === 401 || String(err.message).includes('401')) {
        console.error('❌ Бот: 401 Unauthorized — проверьте BOT_TOKEN в .env');
        return;
      }

      console.error(`Бот polling error [${code || 'ERR'}]: ${err.message}`);
    });

    // Set menu button to open Mini App
    setBotMenuButton();

    console.log(`✅ Telegram бот запущен${retryCount > 0 ? ` (попытка #${retryCount + 1})` : ''}`);
  } catch (err) {
    console.error('Ошибка запуска бота:', err.message);
    const delay = Math.min(10000 + retryCount * 5000, 60000);
    clearTimeout(botRestartTimer);
    botRestartTimer = setTimeout(() => initBot(retryCount + 1), delay);
  }
}

// ─── Start Server ─────────────────────────────────────────────────────────────

ensureDataFiles();

// Log products count on startup for debugging
const startupProducts = (() => {
  try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'data', 'products.json'), 'utf8')); } catch { return []; }
})();
console.log(`📦 Товаров в каталоге: ${startupProducts.length}`);

initBot();

app.listen(PORT, () => {
  console.log(`🚀 Red Shop сервер запущен на порту ${PORT}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`📱 Mini App: ${WEBAPP_URL}`);
});

// Graceful shutdown — останавливаем polling перед выходом
async function shutdown(signal) {
  console.log(`\n${signal} получен, останавливаем бот...`);
  clearTimeout(botRestartTimer);
  if (bot) {
    try { await bot.stopPolling(); } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
