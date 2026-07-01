const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'redshop.db');

let db = null;

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

function boolToInt(v) {
  return v ? 1 : 0;
}

function intToBool(v) {
  return v === 1 || v === true;
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      photo TEXT NOT NULL DEFAULT '/img/placeholder.svg',
      badge TEXT
    );

    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY,
      brandId INTEGER NOT NULL,
      name TEXT NOT NULL,
      photo TEXT NOT NULL DEFAULT '/img/placeholder.svg',
      badge TEXT,
      price INTEGER,
      oldPrice INTEGER
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      oldPrice INTEGER,
      categoryId INTEGER NOT NULL,
      modelId INTEGER,
      photo TEXT NOT NULL DEFAULT '/img/placeholder.svg',
      available INTEGER NOT NULL DEFAULT 1,
      sales INTEGER NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      reserved INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      firstName TEXT NOT NULL DEFAULT '',
      lastName TEXT NOT NULL DEFAULT '',
      firstSeen TEXT,
      lastActive TEXT,
      balance INTEGER NOT NULL DEFAULT 0,
      referrerId INTEGER,
      pendingPromoDiscount INTEGER NOT NULL DEFAULT 0,
      pendingFreeOrder INTEGER NOT NULL DEFAULT 0,
      lastSpinDate TEXT,
      cart TEXT NOT NULL DEFAULT '[]',
      cartUpdatedAt TEXT,
      cartRemindersSent INTEGER NOT NULL DEFAULT 0,
      lastWheelNotifyDate TEXT
    );

    CREATE TABLE IF NOT EXISTS promocodes (
      code TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 0,
      maxActivations INTEGER NOT NULL DEFAULT 1,
      activatedBy TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS banner (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tag TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      subtitle TEXT NOT NULL DEFAULT '',
      buttonText TEXT NOT NULL DEFAULT '',
      bgImage TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      referralBonus INTEGER NOT NULL DEFAULT 30
    );

    CREATE TABLE IF NOT EXISTS messages (
      userId INTEGER PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '[]'
    );
  `);
}

function runSchemaMigrations(database) {
  const cols = database.prepare('PRAGMA table_info(products)').all();
  if (!cols.some(c => c.name === 'reserved')) {
    database.exec('ALTER TABLE products ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0');
  }
}

function isDatabaseEmpty(database) {
  const row = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM categories) +
      (SELECT COUNT(*) FROM products) +
      (SELECT COUNT(*) FROM users) +
      (SELECT COUNT(*) FROM orders) AS total
  `).get();
  return !row || row.total === 0;
}

function readJsonFileIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function importFromJsonFiles(database) {
  const imported = {
    categories: 0,
    models: 0,
    products: 0,
    orders: 0,
    users: 0,
    promocodes: 0,
    messages: 0,
    banner: false,
    settings: false
  };

  const importMany = database.transaction(() => {
    const categories = readJsonFileIfExists(path.join(DATA_DIR, 'categories.json'), []);
    if (Array.isArray(categories) && categories.length) {
      const stmt = database.prepare(
        'INSERT OR REPLACE INTO categories (id, name, photo, badge) VALUES (?, ?, ?, ?)'
      );
      categories.forEach(c => {
        stmt.run(c.id, c.name, c.photo || '/img/placeholder.svg', c.badge || null);
        imported.categories++;
      });
    }

    const models = readJsonFileIfExists(path.join(DATA_DIR, 'models.json'), []);
    if (Array.isArray(models) && models.length) {
      const stmt = database.prepare(
        'INSERT OR REPLACE INTO models (id, brandId, name, photo, badge, price, oldPrice) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      models.forEach(m => {
        stmt.run(
          m.id,
          m.brandId,
          m.name,
          m.photo || '/img/placeholder.svg',
          m.badge || null,
          Number.isFinite(m.price) ? m.price : null,
          Number.isFinite(m.oldPrice) ? m.oldPrice : null
        );
        imported.models++;
      });
    }

    const products = readJsonFileIfExists(path.join(DATA_DIR, 'products.json'), []);
    if (Array.isArray(products) && products.length) {
      const stmt = database.prepare(`
        INSERT OR REPLACE INTO products
        (id, name, price, oldPrice, categoryId, modelId, photo, available, sales, stock, reserved, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      products.forEach(p => {
        stmt.run(
          p.id,
          p.name,
          Number(p.price) || 0,
          Number.isFinite(p.oldPrice) ? p.oldPrice : null,
          p.categoryId,
          p.modelId ?? null,
          p.photo || '/img/placeholder.svg',
          boolToInt(p.available !== false),
          Number(p.sales) || 0,
          Number(p.stock) || 0,
          Number(p.reserved) || 0,
          p.description || ''
        );
        imported.products++;
      });
    }

    const orders = readJsonFileIfExists(path.join(DATA_DIR, 'orders.json'), []);
    if (Array.isArray(orders) && orders.length) {
      const stmt = database.prepare('INSERT OR REPLACE INTO orders (id, data) VALUES (?, ?)');
      orders.forEach(o => {
        stmt.run(o.id, JSON.stringify(o));
        imported.orders++;
      });
    }

    const users = readJsonFileIfExists(path.join(DATA_DIR, 'users.json'), []);
    if (Array.isArray(users) && users.length) {
      const stmt = database.prepare(`
        INSERT OR REPLACE INTO users
        (id, username, firstName, lastName, firstSeen, lastActive, balance, referrerId,
         pendingPromoDiscount, pendingFreeOrder, lastSpinDate, cart, cartUpdatedAt,
         cartRemindersSent, lastWheelNotifyDate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      users.forEach(u => {
        stmt.run(
          u.id,
          u.username || '',
          u.firstName || '',
          u.lastName || '',
          u.firstSeen || null,
          u.lastActive || null,
          Number.isFinite(u.balance) ? u.balance : 0,
          u.referrerId ?? null,
          Number(u.pendingPromoDiscount) || 0,
          boolToInt(!!u.pendingFreeOrder),
          u.lastSpinDate || null,
          JSON.stringify(Array.isArray(u.cart) ? u.cart : []),
          u.cartUpdatedAt || null,
          Number(u.cartRemindersSent) || 0,
          u.lastWheelNotifyDate || null
        );
        imported.users++;
      });
    }

    const promos = readJsonFileIfExists(path.join(DATA_DIR, 'promocodes.json'), []);
    if (Array.isArray(promos) && promos.length) {
      const stmt = database.prepare(
        'INSERT OR REPLACE INTO promocodes (code, type, value, maxActivations, activatedBy) VALUES (?, ?, ?, ?, ?)'
      );
      promos.forEach(p => {
        stmt.run(
          p.code,
          p.type,
          Number(p.value) || 0,
          Number(p.maxActivations) || 1,
          JSON.stringify(Array.isArray(p.activatedBy) ? p.activatedBy : [])
        );
        imported.promocodes++;
      });
    }

    const banner = readJsonFileIfExists(path.join(DATA_DIR, 'banner.json'), null);
    if (banner && typeof banner === 'object' && !Array.isArray(banner)) {
      database.prepare(`
        INSERT OR REPLACE INTO banner (id, tag, title, subtitle, buttonText, bgImage)
        VALUES (1, ?, ?, ?, ?, ?)
      `).run(
        banner.tag || '',
        banner.title || '',
        banner.subtitle || '',
        banner.buttonText || '',
        banner.bgImage || null
      );
      imported.banner = true;
    }

    const settings = readJsonFileIfExists(path.join(DATA_DIR, 'settings.json'), null);
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      const bonus = parseInt(settings.referralBonus, 10);
      database.prepare(
        'INSERT OR REPLACE INTO settings (id, referralBonus) VALUES (1, ?)'
      ).run(Number.isFinite(bonus) && bonus >= 0 ? bonus : 30);
      imported.settings = true;
    }

    const messages = readJsonFileIfExists(path.join(DATA_DIR, 'messages.json'), {});
    if (messages && typeof messages === 'object' && !Array.isArray(messages)) {
      const stmt = database.prepare('INSERT OR REPLACE INTO messages (userId, data) VALUES (?, ?)');
      Object.entries(messages).forEach(([userId, msgs]) => {
        stmt.run(parseInt(userId, 10), JSON.stringify(Array.isArray(msgs) ? msgs : []));
        imported.messages++;
      });
    }

    database.prepare(
      'INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)'
    ).run('json_imported', new Date().toISOString());
  });

  importMany();
  return imported;
}

function ensureDefaultBannerAndSettings(database, { defaultBanner, defaultSettings }) {
  const bannerCount = database.prepare('SELECT COUNT(*) AS c FROM banner').get().c;
  if (bannerCount === 0 && defaultBanner) {
    database.prepare(`
      INSERT INTO banner (id, tag, title, subtitle, buttonText, bgImage)
      VALUES (1, ?, ?, ?, ?, NULL)
    `).run(
      defaultBanner.tag || '',
      defaultBanner.title || '',
      defaultBanner.subtitle || '',
      defaultBanner.buttonText || ''
    );
  }

  const settingsCount = database.prepare('SELECT COUNT(*) AS c FROM settings').get().c;
  if (settingsCount === 0 && defaultSettings) {
    database.prepare(
      'INSERT INTO settings (id, referralBonus) VALUES (1, ?)'
    ).run(defaultSettings.referralBonus ?? 30);
  }
}

function initDatabase(options = {}) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  runSchemaMigrations(db);

  if (isDatabaseEmpty(db)) {
    const stats = importFromJsonFiles(db);
    const total = stats.categories + stats.products + stats.users + stats.orders;
    if (total > 0) {
      console.log('📦 SQLite: импорт из JSON →', stats);
    }
  }

  ensureDefaultBannerAndSettings(db, options);
  return db;
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

function rowToCategory(row) {
  const c = { id: row.id, name: row.name, photo: row.photo };
  if (row.badge) c.badge = row.badge;
  return c;
}

function rowToModel(row) {
  const m = {
    id: row.id,
    brandId: row.brandId,
    name: row.name,
    photo: row.photo
  };
  if (row.badge) m.badge = row.badge;
  if (Number.isFinite(row.price)) m.price = row.price;
  if (Number.isFinite(row.oldPrice)) m.oldPrice = row.oldPrice;
  return m;
}

function rowToProduct(row) {
  const p = {
    id: row.id,
    name: row.name,
    price: row.price,
    categoryId: row.categoryId,
    photo: row.photo,
    available: intToBool(row.available),
    sales: row.sales,
    stock: row.stock,
    reserved: Number(row.reserved) || 0,
    description: row.description
  };
  if (row.oldPrice != null) p.oldPrice = row.oldPrice;
  if (row.modelId != null) p.modelId = row.modelId;
  return p;
}

function rowToUser(row) {
  return {
    id: row.id,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    firstSeen: row.firstSeen,
    lastActive: row.lastActive,
    balance: row.balance,
    referrerId: row.referrerId,
    pendingPromoDiscount: row.pendingPromoDiscount,
    pendingFreeOrder: intToBool(row.pendingFreeOrder),
    lastSpinDate: row.lastSpinDate,
    cart: parseJson(row.cart, []),
    cartUpdatedAt: row.cartUpdatedAt,
    cartRemindersSent: row.cartRemindersSent,
    lastWheelNotifyDate: row.lastWheelNotifyDate
  };
}

function rowToPromocode(row) {
  return {
    code: row.code,
    type: row.type,
    value: row.value,
    maxActivations: row.maxActivations,
    activatedBy: parseJson(row.activatedBy, [])
  };
}

function userToRow(u) {
  return {
    id: u.id,
    username: u.username || '',
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    firstSeen: u.firstSeen || null,
    lastActive: u.lastActive || null,
    balance: Number.isFinite(u.balance) ? u.balance : 0,
    referrerId: u.referrerId ?? null,
    pendingPromoDiscount: Number(u.pendingPromoDiscount) || 0,
    pendingFreeOrder: boolToInt(!!u.pendingFreeOrder),
    lastSpinDate: u.lastSpinDate || null,
    cart: JSON.stringify(Array.isArray(u.cart) ? u.cart : []),
    cartUpdatedAt: u.cartUpdatedAt || null,
    cartRemindersSent: Number(u.cartRemindersSent) || 0,
    lastWheelNotifyDate: u.lastWheelNotifyDate || null
  };
}

// ─── Entity accessors ────────────────────────────────────────────────────────

function getCategories() {
  return getDb().prepare('SELECT * FROM categories ORDER BY id').all().map(rowToCategory);
}

function saveCategories(list) {
  const database = getDb();
  const tx = database.transaction((items) => {
    database.prepare('DELETE FROM categories').run();
    const stmt = database.prepare(
      'INSERT INTO categories (id, name, photo, badge) VALUES (?, ?, ?, ?)'
    );
    items.forEach(c => {
      stmt.run(c.id, c.name, c.photo || '/img/placeholder.svg', c.badge || null);
    });
  });
  tx(Array.isArray(list) ? list : []);
}

function getModels() {
  return getDb().prepare('SELECT * FROM models ORDER BY id').all().map(rowToModel);
}

function saveModels(list) {
  const database = getDb();
  const tx = database.transaction((items) => {
    database.prepare('DELETE FROM models').run();
    const stmt = database.prepare(
      'INSERT INTO models (id, brandId, name, photo, badge, price, oldPrice) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    items.forEach(m => {
      stmt.run(
        m.id,
        m.brandId,
        m.name,
        m.photo || '/img/placeholder.svg',
        m.badge || null,
        Number.isFinite(m.price) ? m.price : null,
        Number.isFinite(m.oldPrice) ? m.oldPrice : null
      );
    });
  });
  tx(Array.isArray(list) ? list : []);
}

function getProducts() {
  return getDb().prepare('SELECT * FROM products ORDER BY id').all().map(rowToProduct);
}

function saveProducts(list) {
  const database = getDb();
  const tx = database.transaction((items) => {
    database.prepare('DELETE FROM products').run();
    const stmt = database.prepare(`
      INSERT INTO products
      (id, name, price, oldPrice, categoryId, modelId, photo, available, sales, stock, reserved, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    items.forEach(p => {
      stmt.run(
        p.id,
        p.name,
        Number(p.price) || 0,
        Number.isFinite(p.oldPrice) ? p.oldPrice : null,
        p.categoryId,
        p.modelId ?? null,
        p.photo || '/img/placeholder.svg',
        boolToInt(p.available !== false),
        Number(p.sales) || 0,
        Number(p.stock) || 0,
        Number(p.reserved) || 0,
        p.description || ''
      );
    });
  });
  tx(Array.isArray(list) ? list : []);
}

function getOrders() {
  return getDb().prepare('SELECT data FROM orders ORDER BY id').all()
    .map(r => parseJson(r.data, null))
    .filter(Boolean);
}

function saveOrders(list) {
  const database = getDb();
  const tx = database.transaction((items) => {
    database.prepare('DELETE FROM orders').run();
    const stmt = database.prepare('INSERT INTO orders (id, data) VALUES (?, ?)');
    (Array.isArray(items) ? items : []).forEach(o => {
      stmt.run(o.id, JSON.stringify(o));
    });
  });
  tx(list);
}

function getUsers() {
  return getDb().prepare('SELECT * FROM users ORDER BY id').all().map(rowToUser);
}

function saveUsers(list) {
  const database = getDb();
  const tx = database.transaction((items) => {
    database.prepare('DELETE FROM users').run();
    const stmt = database.prepare(`
      INSERT INTO users
      (id, username, firstName, lastName, firstSeen, lastActive, balance, referrerId,
       pendingPromoDiscount, pendingFreeOrder, lastSpinDate, cart, cartUpdatedAt,
       cartRemindersSent, lastWheelNotifyDate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    (Array.isArray(items) ? items : []).forEach(u => {
      const row = userToRow(u);
      stmt.run(
        row.id, row.username, row.firstName, row.lastName, row.firstSeen, row.lastActive,
        row.balance, row.referrerId, row.pendingPromoDiscount, row.pendingFreeOrder,
        row.lastSpinDate, row.cart, row.cartUpdatedAt, row.cartRemindersSent, row.lastWheelNotifyDate
      );
    });
  });
  tx(list);
}

function getPromocodes() {
  return getDb().prepare('SELECT * FROM promocodes ORDER BY code').all().map(rowToPromocode);
}

function savePromocodes(list) {
  const database = getDb();
  const tx = database.transaction((items) => {
    database.prepare('DELETE FROM promocodes').run();
    const stmt = database.prepare(
      'INSERT INTO promocodes (code, type, value, maxActivations, activatedBy) VALUES (?, ?, ?, ?, ?)'
    );
    (Array.isArray(items) ? items : []).forEach(p => {
      stmt.run(
        p.code,
        p.type,
        Number(p.value) || 0,
        Number(p.maxActivations) || 1,
        JSON.stringify(Array.isArray(p.activatedBy) ? p.activatedBy : [])
      );
    });
  });
  tx(list);
}

function getBannerObject() {
  const row = getDb().prepare('SELECT * FROM banner WHERE id = 1').get();
  if (!row) return null;
  const banner = {
    tag: row.tag,
    title: row.title,
    subtitle: row.subtitle,
    buttonText: row.buttonText
  };
  if (row.bgImage) banner.bgImage = row.bgImage;
  return banner;
}

function saveBannerObject(banner) {
  if (!banner || typeof banner !== 'object') return;
  getDb().prepare(`
    INSERT OR REPLACE INTO banner (id, tag, title, subtitle, buttonText, bgImage)
    VALUES (1, ?, ?, ?, ?, ?)
  `).run(
    banner.tag || '',
    banner.title || '',
    banner.subtitle || '',
    banner.buttonText || '',
    banner.bgImage || null
  );
}

function getSettingsObject() {
  const row = getDb().prepare('SELECT referralBonus FROM settings WHERE id = 1').get();
  if (!row) return { referralBonus: 30 };
  return { referralBonus: row.referralBonus };
}

function saveSettingsObject(settings) {
  if (!settings || typeof settings !== 'object') return;
  const bonus = parseInt(settings.referralBonus, 10);
  getDb().prepare(
    'INSERT OR REPLACE INTO settings (id, referralBonus) VALUES (1, ?)'
  ).run(Number.isFinite(bonus) && bonus >= 0 ? bonus : 30);
}

function getMessagesObject() {
  const rows = getDb().prepare('SELECT userId, data FROM messages').all();
  const result = {};
  rows.forEach(r => {
    result[String(r.userId)] = parseJson(r.data, []);
  });
  return result;
}

function saveMessagesObject(messages) {
  const database = getDb();
  const tx = database.transaction((obj) => {
    database.prepare('DELETE FROM messages').run();
    const stmt = database.prepare('INSERT INTO messages (userId, data) VALUES (?, ?)');
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      Object.entries(obj).forEach(([userId, msgs]) => {
        stmt.run(parseInt(userId, 10), JSON.stringify(Array.isArray(msgs) ? msgs : []));
      });
    }
  });
  tx(messages);
}

// ─── JSON compatibility layer (used by server.js) ────────────────────────────

const FILE_HANDLERS = {
  'categories.json': { read: getCategories, write: saveCategories },
  'models.json': { read: getModels, write: saveModels },
  'products.json': { read: getProducts, write: saveProducts },
  'orders.json': { read: getOrders, write: saveOrders },
  'users.json': { read: getUsers, write: saveUsers },
  'promocodes.json': { read: getPromocodes, write: savePromocodes },
  'banner.json': { read: getBannerObject, write: saveBannerObject },
  'settings.json': { read: getSettingsObject, write: saveSettingsObject },
  'messages.json': { read: getMessagesObject, write: saveMessagesObject }
};

function readJSON(file) {
  const handler = FILE_HANDLERS[file];
  if (!handler) {
    if (file.endsWith('messages.json')) return {};
    if (file.endsWith('banner.json')) return null;
    return [];
  }
  const data = handler.read();
  if (file === 'messages.json') {
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }
  if (file === 'banner.json') {
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  }
  if (file === 'settings.json') {
    return data && typeof data === 'object' ? data : { referralBonus: 30 };
  }
  return Array.isArray(data) ? data : [];
}

function writeJSON(file, data) {
  const handler = FILE_HANDLERS[file];
  if (!handler) return;
  handler.write(data);
}

module.exports = {
  DATA_DIR,
  DB_PATH,
  initDatabase,
  readJSON,
  writeJSON,
  getDb
};
