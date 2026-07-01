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

const db = require('./db');

const DATA_DIR = db.DATA_DIR;

function readJSON(file) {
  return db.readJSON(file);
}

function writeJSON(file, data) {
  db.writeJSON(file, data);
}

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const uploadsDir = path.join(__dirname, 'public', 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  db.initDatabase({
    defaultBanner: defaultBanner(),
    defaultSettings: defaultSettings()
  });

  let products = readJSON('products.json');
  if (!Array.isArray(products) || products.length === 0) {
    writeJSON('products.json', defaultProducts());
  }

  let categories = readJSON('categories.json');
  if (!Array.isArray(categories) || categories.length === 0) {
    writeJSON('categories.json', defaultCategories());
  }

  let models = readJSON('models.json');
  if (!Array.isArray(models)) writeJSON('models.json', []);

  migrateProductsCategory();
  migrateProductsStock();
  migrateProductsModels();
  migrateModelPricesFromFlavors();

  migrateUsersBalance();
  migrateUsersReferrer();
  migrateUsersNotifications();
  migrateOrdersStatusesAndReservation();
}

const ORDER_STATUSES = ['new', 'done', 'defect', 'cancel'];

const ORDER_STATUS_NOTIFY_LABELS = {
  new: 'Новый 🆕',
  done: 'Выполнено ✅',
  defect: 'Брак ⚠️',
  cancel: 'Отмена ❌'
};

function normalizeOrderStatus(status) {
  if (status === 'processing') return 'new';
  if (ORDER_STATUSES.includes(status)) return status;
  return 'new';
}

function normalizeProductReserved(product) {
  return Math.max(0, Math.round(Number(product?.reserved) || 0));
}

function normalizeProductStock(product) {
  return Math.max(0, Math.round(Number(product?.stock) || 0));
}

function getAvailableStock(product) {
  return Math.max(0, normalizeProductStock(product) - normalizeProductReserved(product));
}

function isProductPurchasable(product) {
  if (!product) return false;
  if (product.available === false) return false;
  return getAvailableStock(product) > 0;
}

function syncProductAvailability(prod) {
  if (getAvailableStock(prod) <= 0) prod.available = false;
}

function applyProductInventoryDelta(prod, { stockDelta = 0, reservedDelta = 0, salesDelta = 0 }) {
  prod.stock = Math.max(0, normalizeProductStock(prod) + stockDelta);
  prod.reserved = Math.max(0, normalizeProductReserved(prod) + reservedDelta);
  prod.sales = Math.max(0, (Number(prod.sales) || 0) + salesDelta);
  syncProductAvailability(prod);
}

function getInventoryTransitionDeltas(fromStatus, toStatus, qty) {
  const from = normalizeOrderStatus(fromStatus);
  const to = normalizeOrderStatus(toStatus);
  const q = Math.max(0, Math.round(Number(qty) || 0));
  if (!q || from === to) return { stockDelta: 0, reservedDelta: 0, salesDelta: 0 };

  let stockDelta = 0;
  let reservedDelta = 0;
  let salesDelta = 0;

  if (from === 'new' && (to === 'done' || to === 'defect')) {
    stockDelta -= q;
    reservedDelta -= q;
    salesDelta += q;
  } else if (from === 'new' && to === 'cancel') {
    reservedDelta -= q;
  } else if (from === 'cancel' && to === 'new') {
    reservedDelta += q;
  } else if (from === 'cancel' && (to === 'done' || to === 'defect')) {
    stockDelta -= q;
    salesDelta += q;
  } else if ((from === 'done' || from === 'defect') && to === 'cancel') {
    stockDelta += q;
    salesDelta -= q;
  } else if ((from === 'done' || from === 'defect') && to === 'new') {
    stockDelta += q;
    reservedDelta += q;
    salesDelta -= q;
  }

  return { stockDelta, reservedDelta, salesDelta };
}

function applyOrderItemsInventory(products, items, deltaFn) {
  (items || []).forEach(item => {
    const prod = products.find(p => Number(p.id) === Number(item.id));
    if (!prod) return;
    const qty = Math.max(0, Math.round(Number(item.qty) || 0));
    if (!qty) return;
    deltaFn(prod, qty);
  });
}

function reserveOrderItems(products, items) {
  applyOrderItemsInventory(products, items, (prod, qty) => {
    applyProductInventoryDelta(prod, { reservedDelta: qty });
  });
}

function applyOrderStatusInventory(products, order, fromStatus, toStatus) {
  applyOrderItemsInventory(products, order.items, (prod, qty) => {
    const deltas = getInventoryTransitionDeltas(fromStatus, toStatus, qty);
    applyProductInventoryDelta(prod, deltas);
  });
}

function migrateOrdersStatusesAndReservation() {
  const orders = readJSON('orders.json');
  const products = readJSON('products.json');
  if (!Array.isArray(orders)) return;

  let ordersChanged = false;
  let productsChanged = false;

  orders.forEach(order => {
    const prevStatus = order.status;
    const normalized = normalizeOrderStatus(order.status);
    if (order.status !== normalized) {
      order.status = normalized;
      ordersChanged = true;
    }

    if (order.reservationMigrated) return;

    if (normalized === 'new') {
      applyOrderItemsInventory(products, order.items, (prod, qty) => {
        prod.stock = normalizeProductStock(prod) + qty;
        applyProductInventoryDelta(prod, { reservedDelta: qty });
        productsChanged = true;
      });
    }

    order.reservationMigrated = true;
    ordersChanged = true;
  });

  if (productsChanged) writeJSON('products.json', products);
  if (ordersChanged) writeJSON('orders.json', orders);
}

function defaultSettings() {
  return { referralBonus: 30 };
}

function readSettings() {
  const parsed = readJSON('settings.json');
  if (!parsed || typeof parsed !== 'object') return defaultSettings();
  const bonus = parseInt(parsed.referralBonus, 10);
  return {
    referralBonus: Number.isFinite(bonus) && bonus >= 0 ? bonus : defaultSettings().referralBonus
  };
}

function getReferralBonus() {
  return readSettings().referralBonus;
}

function defaultBanner() {
  return {
    tag: 'НИЗКИЕ ЦЕНЫ, УЖЕ СЕГОДНЯ',
    title: 'График с 13:00 до 00:00',
    subtitle: 'Поступление уже в боте!!!',
    buttonText: 'Крутить колесо'
  };
}

function readBanner() {
  const banner = readJSON('banner.json');
  if (!banner || typeof banner !== 'object' || Array.isArray(banner)) return defaultBanner();
  const result = {
    tag: banner.tag != null ? String(banner.tag).trim().slice(0, 120) : '',
    title: banner.title != null ? String(banner.title).trim().slice(0, 200) : '',
    subtitle: banner.subtitle != null ? String(banner.subtitle).trim().slice(0, 200) : '',
    buttonText: banner.buttonText != null ? String(banner.buttonText).trim().slice(0, 60) : ''
  };
  if (banner.bgImage && typeof banner.bgImage === 'string') {
    const bg = banner.bgImage.trim();
    if (bg) result.bgImage = bg.slice(0, 500);
  }
  return result;
}

const BOT_USERNAME = 'Red1shopbot';
const ROULETTE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const ROULETTE_SECTORS = [20, 50, 150, 300];
const NOTIFICATION_TZ = process.env.NOTIFICATION_TZ || 'Asia/Bishkek';
const NOTIFICATION_CHECK_MS = 12 * 60 * 1000;
const CART_REMINDER_1_MS = 60 * 60 * 1000;
const CART_REMINDER_2_MS = 24 * 60 * 60 * 1000;

function getRouletteStatus(user) {
  if (!user || !user.lastSpinDate) {
    return { canSpin: true, remainingMs: 0 };
  }
  const last = new Date(user.lastSpinDate).getTime();
  if (!Number.isFinite(last)) {
    return { canSpin: true, remainingMs: 0 };
  }
  const elapsed = Date.now() - last;
  if (elapsed >= ROULETTE_COOLDOWN_MS) {
    return { canSpin: true, remainingMs: 0 };
  }
  return { canSpin: false, remainingMs: ROULETTE_COOLDOWN_MS - elapsed };
}

function pickRoulettePrize() {
  const r = Math.random() * 100;
  if (r < 60) return { prize: 20, sectorIndex: 0 };
  if (r < 85) return { prize: 50, sectorIndex: 1 };
  if (r < 95) return { prize: 150, sectorIndex: 2 };
  return { prize: 300, sectorIndex: 3 };
}

function migrateUsersReferrer() {
  const users = readJSON('users.json');
  if (!Array.isArray(users)) return;
  let changed = false;
  users.forEach(u => {
    if (u.referrerId === undefined) {
      u.referrerId = null;
      changed = true;
    }
    if (u.pendingPromoDiscount === undefined) {
      u.pendingPromoDiscount = 0;
      changed = true;
    }
    if (u.pendingFreeOrder === undefined) {
      u.pendingFreeOrder = false;
      changed = true;
    }
    if (u.lastSpinDate === undefined) {
      u.lastSpinDate = null;
      changed = true;
    }
  });
  if (changed) writeJSON('users.json', users);
}

function migrateUsersNotifications() {
  const users = readJSON('users.json');
  if (!Array.isArray(users)) return;
  let changed = false;
  users.forEach(u => {
    if (!Array.isArray(u.cart)) { u.cart = []; changed = true; }
    if (u.cartUpdatedAt === undefined) { u.cartUpdatedAt = null; changed = true; }
    if (typeof u.cartRemindersSent !== 'number') { u.cartRemindersSent = 0; changed = true; }
    if (u.lastActive === undefined) { u.lastActive = null; changed = true; }
    if (u.lastWheelNotifyDate === undefined) { u.lastWheelNotifyDate = null; changed = true; }
  });
  if (changed) writeJSON('users.json', users);
}

function initUserNotificationFields(user) {
  if (!Array.isArray(user.cart)) user.cart = [];
  if (user.cartUpdatedAt === undefined) user.cartUpdatedAt = null;
  if (typeof user.cartRemindersSent !== 'number') user.cartRemindersSent = 0;
  if (user.lastActive === undefined) user.lastActive = null;
  if (user.lastWheelNotifyDate === undefined) user.lastWheelNotifyDate = null;
  return user;
}

function normalizeCartItem(item) {
  const id = Number(item?.id);
  const qty = Math.max(1, Math.min(99, Math.round(Number(item?.qty) || 1)));
  const products = readJSON('products.json');
  const product = products.find(p => Number(p.id) === id);
  if (!product) return null;
  const models = readJSON('models.json');
  const price = getProductModelPrice(product, models);
  const name = String(item?.name || product.name || '').trim().slice(0, 200);
  if (!id || !name) return null;
  return { id, name, price, qty };
}

function cartSignature(cart) {
  return JSON.stringify(
    (cart || [])
      .map(i => ({ id: Number(i.id), qty: Number(i.qty) }))
      .sort((a, b) => a.id - b.id)
  );
}

function clearUserCart(userId) {
  if (!userId) return;
  const users = readJSON('users.json');
  const user = users.find(u => Number(u.id) === Number(userId));
  if (!user) return;
  initUserNotificationFields(user);
  user.cart = [];
  user.cartUpdatedAt = null;
  user.cartRemindersSent = 0;
  writeJSON('users.json', users);
}

function syncUserCart(userId, items, profile = {}) {
  const users = readJSON('users.json');
  let user = users.find(u => Number(u.id) === Number(userId));
  if (!user) {
    user = ensureUserRecord(userId, profile);
    return syncUserCart(userId, items, profile);
  }
  initUserNotificationFields(user);
  if (profile.username && !user.username) user.username = profile.username;
  if (profile.firstName && !user.firstName) user.firstName = profile.firstName;
  if (profile.lastName && !user.lastName) user.lastName = profile.lastName;

  const normalized = (Array.isArray(items) ? items : [])
    .map(normalizeCartItem)
    .filter(Boolean);
  const prevSig = cartSignature(user.cart);
  const nextSig = cartSignature(normalized);

  user.cart = normalized;
  if (normalized.length === 0) {
    user.cartUpdatedAt = null;
    user.cartRemindersSent = 0;
  } else if (nextSig !== prevSig) {
    user.cartUpdatedAt = new Date().toISOString();
    user.cartRemindersSent = 0;
  }

  writeJSON('users.json', users);
  return user;
}

function touchUserActivity(userId, profile = {}) {
  const users = readJSON('users.json');
  let user = users.find(u => Number(u.id) === Number(userId));
  if (!user) {
    ensureUserRecord(userId, profile);
    return touchUserActivity(userId, profile);
  }
  initUserNotificationFields(user);
  user.lastActive = new Date().toISOString();
  if (profile.username) user.username = profile.username;
  if (profile.firstName) user.firstName = profile.firstName;
  if (profile.lastName) user.lastName = profile.lastName;
  writeJSON('users.json', users);
  return user;
}

function getLocalTimeParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: NOTIFICATION_TZ,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date)
      .filter(p => p.type !== 'literal')
      .map(p => [p.type, p.value])
  );
  return {
    hour: parseInt(parts.hour, 10),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`
  };
}

function isInNotificationWindow(date = new Date()) {
  const { hour } = getLocalTimeParts(date);
  return hour >= 12 && hour < 21;
}

function getWebAppOpenUrl(open) {
  const base = WEBAPP_URL.replace(/\/$/, '');
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}open=${encodeURIComponent(open)}`;
}

function formatCartReminderList(cart) {
  return (cart || []).map(i => `${i.name} ×${i.qty}`).join(', ');
}

function sendCartReminderMessage(user) {
  if (!bot || !user?.id) return;
  const cart = Array.isArray(user.cart) ? user.cart : [];
  if (cart.length === 0) return;
  const list = formatCartReminderList(cart);
  const text = `Привет! Мы заметили, что в твоей корзине остались товары: ${list}. Не забудь оформить заказ, пока они есть в наличии! 😉`;
  const keyboard = {
    inline_keyboard: [[{
      text: '🛒 Перейти в корзину',
      web_app: { url: getWebAppOpenUrl('cart') }
    }]]
  };
  return bot.sendMessage(user.id, text, { reply_markup: keyboard });
}

function sendWheelReminderMessage(user) {
  if (!bot || !user?.id) return;
  const text = 'Твоя бесплатная прокрутка готова! 🎰 Испытай удачу и забери приз';
  const keyboard = {
    inline_keyboard: [[{
      text: '🎰 Крутить колесо',
      web_app: { url: getWebAppOpenUrl('bonus') }
    }]]
  };
  return bot.sendMessage(user.id, text, { reply_markup: keyboard });
}

let notificationProcessing = false;

async function processScheduledNotifications() {
  if (!bot || notificationProcessing) return;
  if (!isInNotificationWindow()) return;

  notificationProcessing = true;
  try {
    const users = readJSON('users.json');
    if (!Array.isArray(users) || users.length === 0) return;

    const now = Date.now();
    const { dateKey: todayKey } = getLocalTimeParts();
    let changed = false;

    for (const user of users) {
      if (!user?.id) continue;
      initUserNotificationFields(user);
      let userChanged = false;

      const cart = user.cart || [];
      if (cart.length > 0 && user.cartUpdatedAt) {
        const updatedAt = new Date(user.cartUpdatedAt).getTime();
        if (Number.isFinite(updatedAt)) {
          const elapsed = now - updatedAt;
          const sent = user.cartRemindersSent || 0;
          if (sent === 0 && elapsed >= CART_REMINDER_1_MS) {
            try {
              await sendCartReminderMessage(user);
              user.cartRemindersSent = 1;
              userChanged = true;
            } catch (err) {
              console.warn(`Cart reminder failed for ${user.id}:`, err.message);
            }
          } else if (sent === 1 && elapsed >= CART_REMINDER_2_MS) {
            try {
              await sendCartReminderMessage(user);
              user.cartRemindersSent = 2;
              userChanged = true;
            } catch (err) {
              console.warn(`Cart reminder 2 failed for ${user.id}:`, err.message);
            }
          }
        }
      }

      const roulette = getRouletteStatus(user);
      if (roulette.canSpin && user.lastWheelNotifyDate !== todayKey) {
        try {
          await sendWheelReminderMessage(user);
          user.lastWheelNotifyDate = todayKey;
          userChanged = true;
        } catch (err) {
          console.warn(`Wheel reminder failed for ${user.id}:`, err.message);
        }
      }

      if (userChanged) changed = true;
      await new Promise(r => setTimeout(r, 120));
    }

    if (changed) writeJSON('users.json', users);
  } finally {
    notificationProcessing = false;
  }
}

function startNotificationScheduler() {
  setInterval(() => {
    processScheduledNotifications().catch(err => {
      console.warn('Notification scheduler:', err.message);
    });
  }, NOTIFICATION_CHECK_MS);

  setTimeout(() => {
    processScheduledNotifications().catch(err => {
      console.warn('Notification scheduler (initial):', err.message);
    });
  }, 30000);

  console.log(`🔔 Планировщик уведомлений: каждые ${NOTIFICATION_CHECK_MS / 60000} мин, окно 12:00–21:00 (${NOTIFICATION_TZ})`);
}

function migrateUsersBalance() {
  const users = readJSON('users.json');
  if (!Array.isArray(users)) return;
  let changed = false;
  users.forEach(u => {
    if (typeof u.balance !== 'number') {
      u.balance = 0;
      changed = true;
    }
  });
  if (changed) writeJSON('users.json', users);
}

function ensureUserRecord(userId, profile = {}) {
  const users = readJSON('users.json');
  let user = users.find(u => Number(u.id) === Number(userId));
  if (!user) {
    user = {
      id: userId,
      username: profile.username || '',
      firstName: profile.firstName || '',
      lastName: profile.lastName || '',
      firstSeen: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      balance: 0,
      referrerId: null,
      pendingPromoDiscount: 0,
      pendingFreeOrder: false,
      lastSpinDate: null,
      cart: [],
      cartUpdatedAt: null,
      cartRemindersSent: 0,
      lastWheelNotifyDate: null
    };
    users.push(user);
    writeJSON('users.json', users);
    return user;
  }
  if (typeof user.balance !== 'number') {
    user.balance = 0;
    writeJSON('users.json', users);
  }
  if (profile.username && !user.username) user.username = profile.username;
  if (profile.firstName && !user.firstName) user.firstName = profile.firstName;
  if (profile.lastName && !user.lastName) user.lastName = profile.lastName;
  return user;
}

function addBalance(userId, amount) {
  const users = readJSON('users.json');
  const user = users.find(u => Number(u.id) === Number(userId));
  if (!user) return null;
  if (typeof user.balance !== 'number') user.balance = 0;
  user.balance = Math.max(0, Math.round(user.balance + amount));
  writeJSON('users.json', users);
  return user.balance;
}

function getTelegramUserFromInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    return JSON.parse(decodeURIComponent(params.get('user') || '{}'));
  } catch {
    return {};
  }
}

function getStartParam(text) {
  if (!text || typeof text !== 'string') return null;
  const parts = text.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : null;
}

function parseReferrerId(startParam) {
  if (!startParam || !startParam.startsWith('ref_')) return null;
  const id = parseInt(startParam.slice(4), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function processReferral(userId, referrerId) {
  if (!referrerId || Number(referrerId) === Number(userId)) return false;
  const users = readJSON('users.json');
  const user = users.find(u => Number(u.id) === Number(userId));
  const referrer = users.find(u => Number(u.id) === Number(referrerId));
  if (!user || !referrer || user.referrerId) return false;

  user.referrerId = referrerId;
  writeJSON('users.json', users);
  const bonus = getReferralBonus();
  addBalance(userId, bonus);
  addBalance(referrerId, bonus);
  return true;
}

function countReferrals(userId) {
  const users = readJSON('users.json');
  return users.filter(u => Number(u.referrerId) === Number(userId)).length;
}

function normalizePromoCode(code) {
  return String(code || '').trim().toUpperCase();
}

function findPromocode(code) {
  const promos = readJSON('promocodes.json');
  const normalized = normalizePromoCode(code);
  return promos.find(p => normalizePromoCode(p.code) === normalized) || null;
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

const DEFAULT_MODEL_NAME = 'Общая';

function findDefaultModelForBrand(models, brandId) {
  return models.find(m =>
    Number(m.brandId) === Number(brandId) &&
    m.name === DEFAULT_MODEL_NAME
  );
}

function migrateProductsModels() {
  const categories = readJSON('categories.json');
  const products = readJSON('products.json');
  if (!Array.isArray(categories)) return;

  let models = readJSON('models.json');
  if (!Array.isArray(models)) models = [];

  let modelsChanged = false;
  let productsChanged = false;

  categories.forEach(cat => {
    if (!findDefaultModelForBrand(models, cat.id)) {
      const newId = models.length > 0 ? Math.max(...models.map(m => m.id)) + 1 : 1;
      models.push({
        id: newId,
        brandId: cat.id,
        name: DEFAULT_MODEL_NAME,
        photo: cat.photo || '/img/placeholder.svg'
      });
      modelsChanged = true;
    }
  });

  products.forEach(p => {
    if (p.modelId) return;
    const brandId = p.categoryId || categories[0]?.id;
    const model = findDefaultModelForBrand(models, brandId);
    if (!model) return;
    p.modelId = model.id;
    if (!p.categoryId) p.categoryId = model.brandId;
    productsChanged = true;
  });

  if (modelsChanged) writeJSON('models.json', models);
  if (productsChanged) writeJSON('products.json', products);
}

function parsePositivePrice(value) {
  const price = parseInt(value, 10);
  return Number.isFinite(price) && price >= 1 ? price : null;
}

function getModelRecord(models, modelId) {
  return (Array.isArray(models) ? models : readJSON('models.json'))
    .find(m => Number(m.id) === Number(modelId));
}

function getProductModelPrice(product, models) {
  const model = getModelRecord(models, product?.modelId);
  if (model && Number.isFinite(model.price) && model.price >= 1) {
    return model.price;
  }
  return Number(product?.price) || 0;
}

function applyModelPriceFields(model, priceRaw, oldPriceRaw) {
  if (priceRaw !== undefined) {
    const price = parsePositivePrice(priceRaw);
    if (price === null) return { error: 'Укажите корректную цену (1 или больше)' };
    model.price = price;
    if (model.oldPrice && model.oldPrice <= model.price) delete model.oldPrice;
  }
  if (oldPriceRaw !== undefined) {
    const currentPrice = parsePositivePrice(model.price) || 0;
    if (oldPriceRaw === '' || oldPriceRaw === null) {
      delete model.oldPrice;
    } else {
      const oldPrice = parseInt(oldPriceRaw, 10);
      if (Number.isFinite(oldPrice) && oldPrice > currentPrice) model.oldPrice = oldPrice;
      else delete model.oldPrice;
    }
  }
  return null;
}

function migrateModelPricesFromFlavors() {
  const models = readJSON('models.json');
  const products = readJSON('products.json');
  if (!Array.isArray(models)) return;

  let changed = false;
  models.forEach(model => {
    if (parsePositivePrice(model.price)) return;
    const flavors = products.filter(p => Number(p.modelId) === Number(model.id));
    if (!flavors.length) return;
    const first = flavors[0];
    const price = parsePositivePrice(first.price);
    if (price) {
      model.price = price;
      changed = true;
    }
    const oldPrice = parseInt(first.oldPrice, 10);
    if (Number.isFinite(oldPrice) && oldPrice > model.price) {
      model.oldPrice = oldPrice;
      changed = true;
    }
  });

  if (changed) writeJSON('models.json', models);
}

function resolveProductModelFields(body, categories, models) {
  const modelsList = Array.isArray(models) ? models : readJSON('models.json');
  const categoriesList = Array.isArray(categories) ? categories : readJSON('categories.json');
  let categoryId = parseInt(body.categoryId, 10);
  let modelId = parseInt(body.modelId, 10);

  if (Number.isFinite(modelId) && modelId > 0) {
    const model = modelsList.find(m => Number(m.id) === modelId);
    if (!model) return { error: 'Модель не найдена' };
    return { modelId: model.id, categoryId: model.brandId };
  }

  if (!Number.isFinite(categoryId) || !categoriesList.some(c => Number(c.id) === categoryId)) {
    categoryId = categoriesList.length > 0 ? categoriesList[0].id : 1;
  }

  const defaultModel = findDefaultModelForBrand(modelsList, categoryId)
    || modelsList.find(m => Number(m.brandId) === categoryId);
  if (!defaultModel) return { error: 'Для бренда нет модели — создайте модель в админке' };

  return { modelId: defaultModel.id, categoryId: defaultModel.brandId };
}

function validateOrderItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { error: 'Корзина пуста', status: 400 };
  }

  const products = readJSON('products.json');
  const categories = readJSON('categories.json');
  const models = readJSON('models.json');
  const qtyById = new Map();

  for (const raw of rawItems) {
    const id = parseInt(raw.id, 10);
    const qty = Math.round(Number(raw.qty) || 0);
    if (!Number.isFinite(id) || id <= 0) {
      return { error: 'Неверный товар в заказе', status: 400 };
    }
    if (qty <= 0) {
      return { error: 'Количество должно быть больше 0', status: 400 };
    }
    qtyById.set(id, (qtyById.get(id) || 0) + qty);
  }

  const items = [];
  let total = 0;

  for (const [id, qty] of qtyById.entries()) {
    const product = products.find(p => Number(p.id) === id);
    if (!product) {
      return { error: `Товар #${id} не найден`, status: 400 };
    }
    if (!isProductPurchasable(product)) {
      const label = product.description || product.name;
      return { error: `«${label}» нет в наличии`, status: 400 };
    }
    const available = getAvailableStock(product);
    if (available < qty) {
      const label = product.description || product.name;
      return { error: `Недостаточно «${label}» в наличии`, status: 400 };
    }

    const price = getProductModelPrice(product, models);
    if (price < 1) {
      const label = product.description || product.name;
      return { error: `Для «${label}» не задана цена модели`, status: 400 };
    }
    const category = categories.find(c => Number(c.id) === Number(product.categoryId));
    items.push({
      id: product.id,
      name: product.name,
      description: product.description || product.name,
      categoryId: product.categoryId,
      categoryName: category ? category.name : '',
      price,
      qty
    });
    total += price * qty;
  }

  return { items, total };
}

function applyServerOrderPayment(userId, total, wantsUseBalance) {
  let promoDiscountUsed = 0;
  let freeOrderApplied = false;

  if (userId) {
    const users = readJSON('users.json');
    const user = users.find(u => Number(u.id) === Number(userId));
    if (user) {
      let userChanged = false;
      if (user.pendingFreeOrder) {
        freeOrderApplied = true;
        user.pendingFreeOrder = false;
        userChanged = true;
      }
      if (user.pendingPromoDiscount > 0) {
        promoDiscountUsed = user.pendingPromoDiscount;
        user.pendingPromoDiscount = 0;
        userChanged = true;
      }
      if (userChanged) writeJSON('users.json', users);
    }
  }

  const discount = freeOrderApplied ? total : Math.min(total, promoDiscountUsed);
  const afterDiscount = Math.max(0, total - discount);

  let balanceUsed = 0;
  if (userId && wantsUseBalance && afterDiscount > 0) {
    const users = readJSON('users.json');
    const user = users.find(u => Number(u.id) === Number(userId));
    const currentBalance = user && typeof user.balance === 'number' ? user.balance : 0;
    balanceUsed = Math.min(afterDiscount, currentBalance);
    if (balanceUsed > 0) addBalance(userId, -balanceUsed);
  }

  const finalTotal = Math.max(0, afterDiscount - balanceUsed);
  return { discount, promoDiscountUsed, freeOrderApplied, balanceUsed, finalTotal };
}

function buildValidatedOrder(orderInput) {
  const {
    items: rawItems,
    userId = null,
    userName = 'Аноним',
    username = '',
    phone = '',
    address = '',
    comment = '',
    categoryName = '',
    categoryId = null,
    useBalance = 0
  } = orderInput;

  const validation = validateOrderItems(rawItems);
  if (validation.error) return validation;

  const wantsUseBalance = userId && Math.max(0, Math.round(Number(useBalance) || 0)) > 0;
  const payment = applyServerOrderPayment(userId, validation.total, wantsUseBalance);

  const order = {
    id: Date.now(),
    userId,
    userName,
    username,
    phone: phone || '',
    address: address || '',
    comment: comment || '',
    categoryName: categoryName || (validation.items.length === 1 ? validation.items[0].categoryName : ''),
    categoryId: categoryId || (validation.items.length === 1 ? validation.items[0].categoryId : null),
    items: validation.items,
    total: validation.total,
    discount: payment.discount,
    wheelDiscount: 0,
    promoDiscountUsed: payment.promoDiscountUsed,
    freeOrderApplied: payment.freeOrderApplied,
    balanceUsed: payment.balanceUsed,
    finalTotal: payment.finalTotal,
    status: 'new',
    createdAt: new Date().toISOString()
  };

  return { order };
}

function persistOrder(order) {
  const orders = readJSON('orders.json');
  order.reservationMigrated = true;
  orders.push(order);
  writeJSON('orders.json', orders);

  const products = readJSON('products.json');
  reserveOrderItems(products, order.items);
  writeJSON('products.json', products);

  if (order.userId) clearUserCart(order.userId);
}

function notifyAdminsNewOrder(order) {
  if (!bot) return;
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
  text += `\n\n💰 Сумма: ${order.total} сом\n`;
  if (order.discount) text += `🎁 Скидка: −${order.discount} сом\n`;
  if (order.promoDiscountUsed) text += `🏷️ Промо-скидка: −${order.promoDiscountUsed} сом\n`;
  if (order.freeOrderApplied) text += `🎁 Бесплатный заказ (промокод)\n`;
  if (order.balanceUsed) text += `💳 С баланса: −${order.balanceUsed} сом\n`;
  text += `✅ Итого: *${order.finalTotal} сом*`;
  ADMIN_IDS.forEach(id => bot.sendMessage(id, text, { parse_mode: 'Markdown' }).catch(() => {}));
}

function getUserBalance(userId) {
  if (!userId) return null;
  const users = readJSON('users.json');
  const u = users.find(x => Number(x.id) === Number(userId));
  return u && typeof u.balance === 'number' ? u.balance : null;
}

function migrateProductsStock() {
  const products = readJSON('products.json');
  if (!Array.isArray(products)) return;
  let changed = false;
  products.forEach(p => {
    if (typeof p.reserved !== 'number' || Number.isNaN(p.reserved)) {
      p.reserved = 0;
      changed = true;
    }
    if (typeof p.stock !== 'number' || Number.isNaN(p.stock)) {
      p.stock = p.available === false ? 0 : 10;
      changed = true;
    }
    if (p.reserved > p.stock) {
      p.reserved = p.stock;
      changed = true;
    }
    const before = p.available;
    syncProductAvailability(p);
    if (p.available !== before) changed = true;
  });
  if (changed) writeJSON('products.json', products);
}

function defaultProducts() {
  return [
    { id: 1, name: 'Watermelon Ice', price: 350, categoryId: 1, photo: '/img/placeholder.svg', available: true, sales: 0, stock: 10, description: 'Арбуз со льдом' },
    { id: 2, name: 'Mango Peach', price: 350, categoryId: 1, photo: '/img/placeholder.svg', available: true, sales: 0, stock: 10, description: 'Манго и персик' },
    { id: 3, name: 'Blueberry Ice', price: 380, categoryId: 1, photo: '/img/placeholder.svg', available: true, sales: 0, stock: 10, description: 'Черника со льдом' },
    { id: 4, name: 'Strawberry Kiwi', price: 350, categoryId: 1, photo: '/img/placeholder.svg', available: true, sales: 0, stock: 10, description: 'Клубника и киви' },
    { id: 5, name: 'Lychee Ice', price: 400, categoryId: 1, photo: '/img/placeholder.svg', available: true, sales: 0, stock: 10, description: 'Личи со льдом' },
    { id: 6, name: 'Grape Ice', price: 350, categoryId: 1, photo: '/img/placeholder.svg', available: false, sales: 0, stock: 0, description: 'Виноград со льдом' },
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
    const prefix = req.originalUrl.includes('/models') ? 'model'
      : req.originalUrl.includes('/categories') ? 'category' : 'product';
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

app.get('/api/banner', (req, res) => {
  res.json(readBanner());
});

app.put('/api/banner', requireAdmin, upload.single('bgImage'), (req, res) => {
  const current = readBanner();
  const body = req.body || {};
  const removeBg = body.removeBgImage === 'true' || body.removeBgImage === true;

  const banner = {
    tag: body.tag !== undefined ? String(body.tag).trim().slice(0, 120) : current.tag,
    title: body.title !== undefined ? String(body.title).trim().slice(0, 200) : current.title,
    subtitle: body.subtitle !== undefined ? String(body.subtitle).trim().slice(0, 200) : current.subtitle,
    buttonText: body.buttonText !== undefined ? String(body.buttonText).trim().slice(0, 60) : current.buttonText
  };

  if (removeBg) {
    // gradient only — no bgImage field
  } else if (req.file) {
    banner.bgImage = `/uploads/${req.file.filename}`;
  } else if (current.bgImage) {
    banner.bgImage = current.bgImage;
  }

  writeJSON('banner.json', banner);
  res.json(banner);
});

app.get('/api/settings', (req, res) => {
  res.json(readSettings());
});

app.put('/api/settings', requireAdmin, (req, res) => {
  const current = readSettings();
  const bonus = parseInt(req.body?.referralBonus, 10);
  if (!Number.isFinite(bonus) || bonus < 0) {
    return res.status(400).json({ error: 'Укажите корректную сумму бонуса (0 или больше)' });
  }
  const settings = { ...current, referralBonus: bonus };
  writeJSON('settings.json', settings);
  res.json(settings);
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
  const badge = (req.body.badge || '').trim();
  if (badge) category.badge = badge;
  categories.push(category);
  writeJSON('categories.json', categories);

  let models = readJSON('models.json');
  if (!Array.isArray(models)) models = [];
  if (!findDefaultModelForBrand(models, category.id)) {
    const modelId = models.length > 0 ? Math.max(...models.map(m => m.id)) + 1 : 1;
    models.push({
      id: modelId,
      brandId: category.id,
      name: DEFAULT_MODEL_NAME,
      photo: category.photo || '/img/placeholder.svg'
    });
    writeJSON('models.json', models);
  }

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
  if (req.body.badge !== undefined) {
    const badge = (req.body.badge || '').trim();
    if (badge) categories[idx].badge = badge;
    else delete categories[idx].badge;
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
  const models = readJSON('models.json');
  const brandModels = models.filter(m => Number(m.brandId) === catId);
  if (brandModels.length > 0) {
    return res.status(400).json({
      error: `Нельзя удалить: у бренда ${brandModels.length} модел(ей). Сначала удалите модели.`
    });
  }
  const categories = readJSON('categories.json');
  const filtered = categories.filter(c => c.id !== catId);
  if (filtered.length === categories.length) return res.status(404).json({ error: 'Позиция не найдена' });
  writeJSON('categories.json', filtered);
  res.json({ ok: true });
});

// Models (public read)
app.get('/api/models', (req, res) => {
  let models = readJSON('models.json');
  if (!Array.isArray(models)) models = [];
  const brandId = req.query.brandId;
  if (brandId !== undefined && brandId !== '') {
    const id = parseInt(brandId, 10);
    if (Number.isFinite(id)) {
      models = models.filter(m => Number(m.brandId) === id);
    }
  }
  res.json(models);
});

app.post('/api/models', requireAdmin, upload.single('photo'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Укажите название модели' });
  const brandId = parseInt(req.body.brandId, 10);
  const categories = readJSON('categories.json');
  if (!Number.isFinite(brandId) || !categories.some(c => Number(c.id) === brandId)) {
    return res.status(400).json({ error: 'Укажите корректный бренд' });
  }
  const models = readJSON('models.json');
  const newId = models.length > 0 ? Math.max(...models.map(m => m.id)) + 1 : 1;
  const model = {
    id: newId,
    brandId,
    name,
    photo: req.file ? `/uploads/${req.file.filename}` : '/img/placeholder.svg'
  };
  const badge = (req.body.badge || '').trim();
  if (badge) model.badge = badge;
  const priceErr = applyModelPriceFields(model, req.body.price, req.body.oldPrice);
  if (priceErr) return res.status(400).json(priceErr);
  if (!parsePositivePrice(model.price)) {
    return res.status(400).json({ error: 'Укажите цену модели' });
  }
  models.push(model);
  writeJSON('models.json', models);
  res.json(model);
});

app.put('/api/models/:id', requireAdmin, upload.single('photo'), (req, res) => {
  const models = readJSON('models.json');
  const categories = readJSON('categories.json');
  const idx = models.findIndex(m => m.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Модель не найдена' });

  if (req.body.name !== undefined) {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Укажите название модели' });
    models[idx].name = name;
  }
  if (req.body.brandId !== undefined) {
    const brandId = parseInt(req.body.brandId, 10);
    if (!Number.isFinite(brandId) || !categories.some(c => Number(c.id) === brandId)) {
      return res.status(400).json({ error: 'Укажите корректный бренд' });
    }
    models[idx].brandId = brandId;
    const products = readJSON('products.json');
    let productsChanged = false;
    products.forEach(p => {
      if (Number(p.modelId) === Number(models[idx].id) && Number(p.categoryId) !== brandId) {
        p.categoryId = brandId;
        productsChanged = true;
      }
    });
    if (productsChanged) writeJSON('products.json', products);
  }
  if (req.body.badge !== undefined) {
    const badge = (req.body.badge || '').trim();
    if (badge) models[idx].badge = badge;
    else delete models[idx].badge;
  }
  if (req.body.price !== undefined || req.body.oldPrice !== undefined) {
    const priceErr = applyModelPriceFields(models[idx], req.body.price, req.body.oldPrice);
    if (priceErr) return res.status(400).json(priceErr);
    const products = readJSON('products.json');
    let productsChanged = false;
    products.forEach(p => {
      if (Number(p.modelId) !== Number(models[idx].id)) return;
      p.price = models[idx].price;
      if (models[idx].oldPrice && models[idx].oldPrice > p.price) p.oldPrice = models[idx].oldPrice;
      else delete p.oldPrice;
      productsChanged = true;
    });
    if (productsChanged) writeJSON('products.json', products);
  }
  if (req.file) models[idx].photo = `/uploads/${req.file.filename}`;
  writeJSON('models.json', models);
  res.json(models[idx]);
});

app.delete('/api/models/:id', requireAdmin, (req, res) => {
  const modelId = parseInt(req.params.id);
  const products = readJSON('products.json');
  const linked = products.filter(p => Number(p.modelId) === modelId);
  if (linked.length > 0) {
    return res.status(400).json({
      error: `Нельзя удалить: к модели привязано ${linked.length} вкус(ов). Сначала удалите или перенесите их.`
    });
  }
  const models = readJSON('models.json');
  const filtered = models.filter(m => m.id !== modelId);
  if (filtered.length === models.length) return res.status(404).json({ error: 'Модель не найдена' });
  writeJSON('models.json', filtered);
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
  const models = readJSON('models.json');
  const resolved = resolveProductModelFields(req.body, categories, models);
  if (resolved.error) return res.status(400).json({ error: resolved.error });

  const model = getModelRecord(models, resolved.modelId);
  const modelPrice = getProductModelPrice({ modelId: resolved.modelId, price: req.body.price }, models);
  if (modelPrice < 1) {
    return res.status(400).json({ error: 'Сначала укажите цену у модели' });
  }

  const newId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
  const product = {
    id: newId,
    name: req.body.name,
    price: modelPrice,
    categoryId: resolved.categoryId,
    modelId: resolved.modelId,
    photo: req.file ? `/uploads/${req.file.filename}` : '/img/placeholder.svg',
    available: true,
    sales: 0,
    stock: Math.max(0, parseInt(req.body.stock, 10) || 10),
    description: req.body.description || ''
  };
  if (model?.oldPrice && model.oldPrice > modelPrice) product.oldPrice = model.oldPrice;
  if (product.stock <= 0) product.available = false;
  products.push(product);
  writeJSON('products.json', products);
  res.json(product);
});

app.put('/api/products/:id', requireAdmin, upload.single('photo'), (req, res) => {
  const products = readJSON('products.json');
  const categories = readJSON('categories.json');
  const models = readJSON('models.json');
  const idx = products.findIndex(p => p.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Товар не найден' });

  if (req.body.name !== undefined) products[idx].name = req.body.name;
  if (req.body.available !== undefined) products[idx].available = req.body.available === 'true' || req.body.available === true;
  if (req.body.description !== undefined) products[idx].description = req.body.description;
  if (req.body.stock !== undefined) {
    const stock = Math.max(0, parseInt(req.body.stock, 10) || 0);
    products[idx].stock = stock;
    if (stock <= 0) products[idx].available = false;
    else if (req.body.available === undefined) products[idx].available = true;
  }
  if (req.body.modelId !== undefined) {
    const modelId = parseInt(req.body.modelId, 10);
    const model = models.find(m => Number(m.id) === modelId);
    if (!model) return res.status(400).json({ error: 'Модель не найдена' });
    products[idx].modelId = model.id;
    products[idx].categoryId = model.brandId;
  } else if (req.body.categoryId !== undefined) {
    const categoryId = parseInt(req.body.categoryId, 10);
    if (!isNaN(categoryId) && categories.some(c => c.id === categoryId)) {
      products[idx].categoryId = categoryId;
      const defaultModel = findDefaultModelForBrand(models, categoryId)
        || models.find(m => Number(m.brandId) === categoryId);
      if (defaultModel) products[idx].modelId = defaultModel.id;
    }
  }
  const linkedModel = getModelRecord(models, products[idx].modelId);
  products[idx].price = getProductModelPrice(products[idx], models);
  if (linkedModel?.oldPrice && linkedModel.oldPrice > products[idx].price) {
    products[idx].oldPrice = linkedModel.oldPrice;
  } else {
    delete products[idx].oldPrice;
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

app.get('/api/users/me', (req, res) => {
  const initData = req.headers['x-telegram-init-data'];
  const verifiedUserId = getVerifiedTelegramUserId(initData);
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const tgUser = getTelegramUserFromInitData(initData);
  const profile = {
    username: tgUser.username || '',
    firstName: tgUser.first_name || '',
    lastName: tgUser.last_name || ''
  };
  const user = touchUserActivity(verifiedUserId, profile);
  res.json({
    id: user.id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    balance: user.balance,
    firstSeen: user.firstSeen,
    lastActive: user.lastActive || null,
    pendingPromoDiscount: user.pendingPromoDiscount || 0,
    pendingFreeOrder: !!user.pendingFreeOrder,
    referralCount: countReferrals(verifiedUserId)
  });
});

app.post('/api/cart/sync', (req, res) => {
  const initData = req.headers['x-telegram-init-data'];
  const verifiedUserId = getVerifiedTelegramUserId(initData);
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const tgUser = getTelegramUserFromInitData(initData);
  syncUserCart(verifiedUserId, req.body?.items, {
    username: tgUser.username || '',
    firstName: tgUser.first_name || '',
    lastName: tgUser.last_name || ''
  });
  res.json({ ok: true });
});

app.get('/api/geocode/reverse', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
  const options = {
    headers: {
      'User-Agent': 'RedShop-MiniApp/1.0 (contact: support@redshop.local)',
      'Accept-Language': 'ru'
    }
  };

  https.get(url, options, (geoRes) => {
    let body = '';
    geoRes.on('data', chunk => { body += chunk; });
    geoRes.on('end', () => {
      try {
        const data = JSON.parse(body);
        const address = data.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        res.json({ address, lat, lon });
      } catch {
        res.json({ address: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon });
      }
    });
  }).on('error', () => {
    res.json({ address: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon });
  });
});

app.get('/api/referrals/my', (req, res) => {
  const verifiedUserId = getVerifiedTelegramUserId(req.headers['x-telegram-init-data']);
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    count: countReferrals(verifiedUserId),
    link: `https://t.me/${BOT_USERNAME}?start=ref_${verifiedUserId}`,
    bonus: getReferralBonus()
  });
});

app.post('/api/promo/activate', (req, res) => {
  const initData = req.headers['x-telegram-init-data'];
  const verifiedUserId = getVerifiedTelegramUserId(initData);
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const code = normalizePromoCode(req.body?.code);
  if (!code) return res.status(400).json({ error: 'Введите промокод' });

  const promos = readJSON('promocodes.json');
  const promo = promos.find(p => normalizePromoCode(p.code) === code);
  if (!promo) return res.status(404).json({ error: 'Промокод не найден' });

  if (!Array.isArray(promo.activatedBy)) promo.activatedBy = [];
  if (promo.activatedBy.some(id => Number(id) === Number(verifiedUserId))) {
    return res.status(400).json({ error: 'Вы уже активировали этот промокод' });
  }

  const maxActivations = Number(promo.maxActivations) || 0;
  if (maxActivations > 0 && promo.activatedBy.length >= maxActivations) {
    return res.status(400).json({ error: 'Промокод исчерпан' });
  }

  const tgUser = getTelegramUserFromInitData(initData);
  ensureUserRecord(verifiedUserId, {
    username: tgUser.username || '',
    firstName: tgUser.first_name || '',
    lastName: tgUser.last_name || ''
  });

  const value = Math.max(0, Math.round(Number(promo.value) || 0));
  let message = '';
  let newBalance = null;

  if (promo.type === 'balance') {
    newBalance = addBalance(verifiedUserId, value);
    message = `На баланс начислено ${value} сом`;
  } else if (promo.type === 'discount') {
    const users = readJSON('users.json');
    const user = users.find(u => Number(u.id) === Number(verifiedUserId));
    if (user) {
      user.pendingPromoDiscount = (user.pendingPromoDiscount || 0) + value;
      writeJSON('users.json', users);
    }
    message = `Скидка ${value} сом будет применена к следующему заказу`;
  } else if (promo.type === 'free_order') {
    const users = readJSON('users.json');
    const user = users.find(u => Number(u.id) === Number(verifiedUserId));
    if (user) {
      user.pendingFreeOrder = true;
      writeJSON('users.json', users);
    }
    message = 'Следующий заказ будет бесплатным';
  } else {
    return res.status(400).json({ error: 'Неизвестный тип промокода' });
  }

  promo.activatedBy.push(verifiedUserId);
  writeJSON('promocodes.json', promos);

  const users = readJSON('users.json');
  const user = users.find(u => Number(u.id) === Number(verifiedUserId));

  res.json({
    ok: true,
    message,
    type: promo.type,
    value,
    newBalance: newBalance ?? user?.balance ?? 0,
    pendingPromoDiscount: user?.pendingPromoDiscount || 0,
    pendingFreeOrder: !!user?.pendingFreeOrder
  });
});

app.get('/api/promocodes', requireAdmin, (req, res) => {
  res.json(readJSON('promocodes.json'));
});

app.post('/api/promocodes', requireAdmin, (req, res) => {
  const { code, type, value, maxActivations } = req.body;
  const normalized = normalizePromoCode(code);
  if (!normalized) return res.status(400).json({ error: 'Код обязателен' });
  if (!['balance', 'discount', 'free_order'].includes(type)) {
    return res.status(400).json({ error: 'Неверный тип промокода' });
  }

  const promos = readJSON('promocodes.json');
  if (promos.some(p => normalizePromoCode(p.code) === normalized)) {
    return res.status(400).json({ error: 'Такой промокод уже существует' });
  }

  const promo = {
    code: normalized,
    type,
    value: Math.max(0, Math.round(Number(value) || 0)),
    maxActivations: Math.max(0, Math.round(Number(maxActivations) || 1)),
    activatedBy: []
  };
  promos.push(promo);
  writeJSON('promocodes.json', promos);
  res.json(promo);
});

app.delete('/api/promocodes/:code', requireAdmin, (req, res) => {
  const normalized = normalizePromoCode(req.params.code);
  const promos = readJSON('promocodes.json');
  const filtered = promos.filter(p => normalizePromoCode(p.code) !== normalized);
  if (filtered.length === promos.length) {
    return res.status(404).json({ error: 'Промокод не найден' });
  }
  writeJSON('promocodes.json', filtered);
  res.json({ ok: true });
});

app.get('/api/roulette/status', (req, res) => {
  const initData = req.headers['x-telegram-init-data'];
  const verifiedUserId = getVerifiedTelegramUserId(initData);
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const tgUser = getTelegramUserFromInitData(initData);
  const user = ensureUserRecord(verifiedUserId, {
    username: tgUser.username || '',
    firstName: tgUser.first_name || '',
    lastName: tgUser.last_name || ''
  });
  const status = getRouletteStatus(user);
  res.json({
    canSpin: status.canSpin,
    remainingMs: status.remainingMs,
    lastSpinDate: user.lastSpinDate || null
  });
});

app.post('/api/roulette/spin', (req, res) => {
  const initData = req.headers['x-telegram-init-data'];
  const verifiedUserId = getVerifiedTelegramUserId(initData);
  if (!verifiedUserId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const tgUser = getTelegramUserFromInitData(initData);
  ensureUserRecord(verifiedUserId, {
    username: tgUser.username || '',
    firstName: tgUser.first_name || '',
    lastName: tgUser.last_name || ''
  });

  const users = readJSON('users.json');
  const user = users.find(u => Number(u.id) === Number(verifiedUserId));
  if (!user) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }

  const status = getRouletteStatus(user);
  if (!status.canSpin) {
    return res.status(429).json({
      error: 'Крутить можно только раз в 24 часа',
      canSpin: false,
      remainingMs: status.remainingMs
    });
  }

  const { prize, sectorIndex } = pickRoulettePrize();
  user.lastSpinDate = new Date().toISOString();
  writeJSON('users.json', users);
  const balance = addBalance(verifiedUserId, prize);

  res.json({
    prize,
    sectorIndex,
    balance,
    canSpin: false,
    remainingMs: ROULETTE_COOLDOWN_MS
  });
});

app.post('/api/orders', (req, res) => {
  const initData = req.headers['x-telegram-init-data'];
  const verifiedUserId = getVerifiedTelegramUserId(initData);
  const body = req.body || {};

  let userId = null;
  let userName = body.userName || 'Аноним';
  let username = body.username || '';

  if (verifiedUserId) {
    const tgUser = getTelegramUserFromInitData(initData);
    ensureUserRecord(verifiedUserId, {
      username: tgUser.username || '',
      firstName: tgUser.first_name || '',
      lastName: tgUser.last_name || ''
    });
    userId = verifiedUserId;
    userName = `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim() || tgUser.username || String(verifiedUserId);
    username = tgUser.username || '';
  }

  const result = buildValidatedOrder({
    items: body.items,
    userId,
    userName,
    username,
    phone: body.phone,
    address: body.address,
    comment: body.comment,
    categoryName: body.categoryName,
    categoryId: body.categoryId,
    useBalance: body.useBalance
  });

  if (result.error) {
    return res.status(result.status || 400).json({ error: result.error });
  }

  const { order } = result;
  persistOrder(order);
  notifyAdminsNewOrder(order);

  if (bot && order.userId) {
    sendWelcomeMessage(order.userId).catch(() => {});
  }

  res.json({ ...order, newBalance: getUserBalance(userId) });
});

app.put('/api/orders/:id/status', requireAdmin, (req, res) => {
  const orders = readJSON('orders.json');
  const order = orders.find(o => o.id === parseInt(req.params.id));
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });

  const newStatus = normalizeOrderStatus(req.body.status);
  if (!ORDER_STATUSES.includes(newStatus)) {
    return res.status(400).json({ error: 'Недопустимый статус заказа' });
  }

  const commentProvided = req.body.comment !== undefined;
  const nextComment = commentProvided
    ? String(req.body.comment || '').trim()
    : String(order.comment || '').trim();

  if (newStatus === 'cancel' && !nextComment) {
    return res.status(400).json({ error: 'Для отмены заказа укажите комментарий' });
  }

  const prevStatus = normalizeOrderStatus(order.status);
  if (prevStatus !== newStatus) {
    const products = readJSON('products.json');
    applyOrderStatusInventory(products, order, prevStatus, newStatus);
    writeJSON('products.json', products);
  }

  order.status = newStatus;
  if (commentProvided) order.comment = nextComment;
  writeJSON('orders.json', orders);

  if (bot && order.userId) {
    const label = ORDER_STATUS_NOTIFY_LABELS[newStatus] || newStatus;
    bot.sendMessage(order.userId, `Статус вашего заказа #${order.id} изменён: ${label}`).catch(() => {});
  }

  res.json(order);
});

app.put('/api/orders/:id/comment', requireAdmin, (req, res) => {
  const orders = readJSON('orders.json');
  const order = orders.find(o => o.id === parseInt(req.params.id));
  if (!order) return res.status(404).json({ error: 'Заказ не найден' });

  order.comment = String(req.body?.comment || '').trim();
  writeJSON('orders.json', orders);
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
      const isNewUser = !existing;
      if (!existing) {
        users.push({
          id: userId,
          username: user.username || '',
          firstName: user.first_name || '',
          lastName: user.last_name || '',
          firstSeen: new Date().toISOString(),
          balance: 0,
          referrerId: null,
          pendingPromoDiscount: 0,
          pendingFreeOrder: false
        });
        writeJSON('users.json', users);
      } else {
        let changed = false;
        if (typeof existing.balance !== 'number') { existing.balance = 0; changed = true; }
        if (existing.referrerId === undefined) { existing.referrerId = null; changed = true; }
        if (existing.pendingPromoDiscount === undefined) { existing.pendingPromoDiscount = 0; changed = true; }
        if (existing.pendingFreeOrder === undefined) { existing.pendingFreeOrder = false; changed = true; }
        if (changed) writeJSON('users.json', users);
      }

      // Handle /start (включая /start welcome и /start ref_<id>)
      if (isStartCommand(msg.text)) {
        const startParam = getStartParam(msg.text);
        const referrerId = parseReferrerId(startParam);
        if (referrerId && isNewUser) {
          const applied = processReferral(userId, referrerId);
          if (applied && bot) {
            const bonus = getReferralBonus();
            bot.sendMessage(chatId, `🎉 Реферальный бонус: +${bonus} сом на ваш баланс!`).catch(() => {});
            bot.sendMessage(referrerId, `👥 По вашей ссылке пришёл новый пользователь! +${bonus} сом на баланс.`).catch(() => {});
          } else if (isNewUser && referrerId && Number(referrerId) === Number(userId)) {
            // self-referral — ignore silently
          }
        }
        await sendWelcomeMessage(chatId);
        return;
      }

      // Handle web_app_data (order from Mini App)
      if (msg.web_app_data) {
        try {
          const orderData = JSON.parse(msg.web_app_data.data);
          ensureUserRecord(userId, {
            username: user.username || '',
            firstName: user.first_name || '',
            lastName: user.last_name || ''
          });

          const result = buildValidatedOrder({
            items: orderData.items,
            userId,
            userName: `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.username || String(userId),
            username: user.username || '',
            phone: orderData.phone,
            address: orderData.address,
            comment: orderData.comment,
            categoryName: orderData.categoryName,
            categoryId: orderData.categoryId,
            useBalance: orderData.useBalance
          });

          if (result.error) {
            bot.sendMessage(chatId, `❌ ${result.error}`).catch(() => {});
            return;
          }

          const { order } = result;
          persistOrder(order);
          notifyAdminsNewOrder(order);

          let customerText = `✅ *Заказ #${order.id} принят!*\n\n` +
            `📦 ${(order.items || []).map(i => `${i.description || i.name} ×${i.qty} — ${i.price * i.qty} сом`).join('\n')}\n`;
          if (order.discount) customerText += `🎁 Скидка: −${order.discount} сом\n`;
          if (order.balanceUsed) customerText += `💳 С баланса: −${order.balanceUsed} сом\n`;
          customerText += `\n💰 Итого: *${order.finalTotal} сом*\n\nМы свяжемся с вами в ближайшее время!`;
          bot.sendMessage(chatId, customerText, { parse_mode: 'Markdown' }).catch(() => {});
        } catch (e) {
          console.error('Ошибка обработки заказа:', e);
          bot.sendMessage(chatId, '❌ Не удалось оформить заказ. Попробуйте снова.').catch(() => {});
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
console.log(`💾 SQLite: ${db.DB_PATH}`);

// Log products count on startup for debugging
const startupProducts = (() => {
  try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'data', 'products.json'), 'utf8')); } catch { return []; }
})();
console.log(`📦 Товаров в каталоге: ${startupProducts.length}`);

initBot();
startNotificationScheduler();

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
  try { db.getDb().close(); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
