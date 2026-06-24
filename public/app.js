/* ═══════════════════════════════════════════════════════════════
   Red Shop — Telegram Mini App
   ═══════════════════════════════════════════════════════════════ */

// ─── Telegram WebApp init ────────────────────────────────────────────────────
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#140808');
  tg.setBackgroundColor('#140808');
}

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  products: [],
  categories: [],
  selectedCategoryId: null,
  cart: [],        // [{id, name, price, photo, qty}]
  discount: 0,
  adminPassword: null,       // legacy (kept for backward compat)
  telegramInitData: null,    // Telegram initData string (cryptographic)
  adminUserId: null,         // verified admin Telegram user ID
  isAdmin: false,
  currentAdminTab: 'products',
  currentChatUserId: null,
  ordersFilter: 'all',
  wheelRotation: 0,
  spinning: false,
  buyProductId: null,
  currentMainTab: 'catalog'
};

// ─── API ─────────────────────────────────────────────────────────────────────
const API = '/api';

// Build admin auth headers from whichever credential is available
function adminHeaders() {
  const h = {};
  if (state.adminPassword)    h['x-admin-password']     = state.adminPassword;
  if (state.telegramInitData) h['x-telegram-init-data'] = state.telegramInitData;
  if (state.adminUserId)      h['x-admin-userid']        = String(state.adminUserId);
  return h;
}

// Wrapper for admin fetch calls with FormData (multer doesn't accept JSON)
async function adminFormFetch(method, url, formData) {
  const res = await fetch(url, { method, headers: adminHeaders(), body: formData });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function api(method, endpoint, body, adminRequired = false) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (adminRequired) {
    Object.assign(opts.headers, adminHeaders());
  }
  if (body && !(body instanceof FormData)) {
    opts.body = JSON.stringify(body);
  }
  if (body instanceof FormData) {
    delete opts.headers['Content-Type'];
    opts.body = body;
  }
  try {
    const res = await fetch(API + endpoint, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
    return data;
  } catch (err) {
    throw err;
  }
}

// ─── Toast notifications ─────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ─── Modal helpers ────────────────────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.body.style.overflow = '';
}
function closeOnOverlay(e, id) {
  if (e.target === e.currentTarget) closeModal(id);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  switchMainTab('catalog');
  await initShop();
  checkSpinStatus();
  checkExistingDiscount();
  initAdminCheck();
});

// ═══════════════════════════════════════════════════════════════
// MAIN TABS (bottom nav)
// ═══════════════════════════════════════════════════════════════

const MAIN_TAB_VIEWS = {
  bonus: 'bonusView',
  catalog: 'shopView',
  profile: 'profileView'
};

function setBottomNavVisible(visible) {
  document.getElementById('bottomNav')?.classList.toggle('hidden', !visible);
}

function switchMainTab(tab) {
  if (!MAIN_TAB_VIEWS[tab]) return;
  state.currentMainTab = tab;

  Object.entries(MAIN_TAB_VIEWS).forEach(([key, viewId]) => {
    document.getElementById(viewId)?.classList.toggle('hidden', key !== tab);
  });

  document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
}

// ═══════════════════════════════════════════════════════════════
// SHOP
// ═══════════════════════════════════════════════════════════════

function getCategoryName(categoryId) {
  const cat = state.categories.find(c => c.id === categoryId);
  return cat ? cat.name : '—';
}

function getCategoryProductCount(categoryId) {
  return state.products.filter(p => p.categoryId === categoryId).length;
}

async function initShop(attempt = 1) {
  const categoriesView = document.getElementById('categoriesView');
  const catalog = document.getElementById('catalog');
  const empty = document.getElementById('catalogEmpty');

  if (attempt === 1) {
    categoriesView.innerHTML = `
      <div class="loading-products" style="text-align:center;padding:40px 20px;color:#888">
        <div style="font-size:2rem;margin-bottom:10px">⏳</div>
        <div>Загрузка каталога...</div>
      </div>`;
    catalog.classList.add('hidden');
    categoriesView.classList.remove('hidden');
    empty.classList.add('hidden');
  }

  try {
    const [products, categories] = await Promise.all([
      api('GET', '/products'),
      api('GET', '/categories')
    ]);
    if (!Array.isArray(products) || !Array.isArray(categories)) {
      throw new Error('Сервер вернул неверный формат');
    }
    state.products = products;
    state.categories = categories;
    state.selectedCategoryId = null;
    showCategoriesView();
  } catch (err) {
    if (attempt < 4) {
      const delay = attempt * 5000;
      categoriesView.innerHTML = `
        <div class="loading-products" style="text-align:center;padding:40px 20px;color:#888">
          <div style="font-size:2rem;margin-bottom:10px">🔄</div>
          <div>Сервер запускается, подождите...</div>
          <div style="font-size:0.8rem;margin-top:6px;color:#555">Попытка ${attempt + 1} через ${delay / 1000} сек</div>
        </div>`;
      setTimeout(() => initShop(attempt + 1), delay);
    } else {
      categoriesView.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML = `
        <div class="empty-icon">⚠️</div>
        <div>Не удалось загрузить каталог</div>
        <div style="font-size:0.8rem;color:#666;margin-top:6px">${err.message}</div>
        <button class="btn-outline" style="margin-top:16px" onclick="initShop()">Попробовать снова</button>`;
      showToast('Ошибка загрузки каталога', 'error');
    }
  }
}

async function loadProducts(attempt = 1) {
  try {
    const [products, categories] = await Promise.all([
      api('GET', '/products'),
      api('GET', '/categories')
    ]);
    state.products = products;
    state.categories = categories;
    if (state.selectedCategoryId) renderCatalog();
    else showCategoriesView();
  } catch (err) {
    if (attempt < 4) {
      setTimeout(() => loadProducts(attempt + 1), attempt * 5000);
    } else {
      showToast('Ошибка загрузки товаров', 'error');
    }
  }
}

function showCategoriesView() {
  state.selectedCategoryId = null;
  document.getElementById('catalogTitle').textContent = 'Waka line';
  document.getElementById('catalogBackBtn').classList.add('hidden');
  document.getElementById('catalog').classList.add('hidden');
  document.getElementById('catalogEmpty').classList.add('hidden');
  document.getElementById('categoriesView').classList.remove('hidden');
  renderCategories();
}

function normalizePhotoSrc(photo) {
  if (!photo) return '/img/placeholder.svg';
  if (photo.startsWith('http')) return photo;
  return photo.startsWith('/') ? photo : '/' + photo;
}

function renderCategories() {
  const grid = document.getElementById('categoriesView');
  const countEl = document.getElementById('catalogCount');

  grid.innerHTML = '';
  countEl.textContent = `${state.categories.length} поз.`;

  if (state.categories.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">📦</div>
        <div>Позиции не найдены</div>
      </div>`;
    return;
  }

  state.categories.forEach(cat => {
    const total = getCategoryProductCount(cat.id);
    const available = state.products.filter(p => p.categoryId === cat.id && p.available).length;
    const photoSrc = normalizePhotoSrc(cat.photo);
    const hasRealPhoto = cat.photo && !cat.photo.includes('placeholder');
    const card = document.createElement('div');
    card.className = 'category-card';
    card.onclick = () => openCategory(cat.id);
    card.innerHTML = `
      <div class="category-card-photo-wrap">
        ${hasRealPhoto
          ? `<img class="category-card-photo" src="${photoSrc}" alt="${escapeHtml(cat.name)}" loading="lazy"
              onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'category-card-photo-placeholder',textContent:'📦'}))">`
          : `<div class="category-card-photo-placeholder">📦</div>`}
      </div>
      <div class="category-card-body">
        <div>
          <div class="category-card-name">${escapeHtml(cat.name)}</div>
          <div class="category-card-meta">${available} вкусов${total !== available ? ` · всего ${total}` : ''}</div>
        </div>
        <span class="category-card-arrow">›</span>
      </div>
    `;
    grid.appendChild(card);
  });
}

function openCategory(categoryId) {
  state.selectedCategoryId = categoryId;
  const cat = state.categories.find(c => c.id === categoryId);
  document.getElementById('catalogTitle').textContent = cat ? cat.name : 'Waka line';
  document.getElementById('catalogBackBtn').classList.remove('hidden');
  document.getElementById('categoriesView').classList.add('hidden');
  document.getElementById('catalog').classList.remove('hidden');
  document.getElementById('catalogEmpty').classList.add('hidden');
  renderCatalog();
}

function backToCategories() {
  showCategoriesView();
}

function formatProductPriceHtml(product) {
  const price = Number(product.price) || 0;
  const oldPrice = Number(product.oldPrice);
  if (oldPrice && oldPrice > price) {
    return `<span class="price-old">${oldPrice} сом</span><span class="price-current">${price} сом</span>`;
  }
  return `<span class="price-current">${price} сом</span>`;
}

function renderCatalog() {
  const grid = document.getElementById('catalog');
  const empty = document.getElementById('catalogEmpty');
  const count = document.getElementById('catalogCount');

  const categoryId = state.selectedCategoryId;
  const categoryProducts = categoryId
    ? state.products.filter(p => p.categoryId === categoryId)
    : state.products;
  const available = categoryProducts.filter(p => p.available);

  grid.className = 'catalog-grid flavors-list';
  grid.innerHTML = '';
  count.textContent = `${available.length} вкусов`;

  if (categoryProducts.length === 0) {
    empty.classList.remove('hidden');
    empty.innerHTML = `
      <div class="empty-icon">📦</div>
      <div>В этой позиции пока нет вкусов</div>`;
    return;
  }
  empty.classList.add('hidden');

  categoryProducts.forEach((product) => {
    const row = document.createElement('div');
    row.className = `flavor-row${!product.available ? ' out-of-stock' : ''}`;
    row.id = `productCard_${product.id}`;

    row.innerHTML = `
      <div class="flavor-row-info">
        <div class="flavor-row-name">${escapeHtml(product.description || product.name)}</div>
        ${!product.available ? '<div class="category-card-meta">Нет в наличии</div>' : ''}
      </div>
      <div class="flavor-row-prices">${formatProductPriceHtml(product)}</div>
      <button class="btn-buy" type="button"
        ${!product.available ? 'disabled' : ''}
        onclick="openBuyModal(${product.id})">
        Купить
      </button>
    `;
    grid.appendChild(row);
  });
}

function previewImage(src) {
  if (!src || src.includes('placeholder')) return;
  document.getElementById('imagePreviewImg').src = src;
  openModal('imagePreviewModal');
}

// ─── Cart ─────────────────────────────────────────────────────────────────────
function toggleCart(productId) {
  const product = state.products.find(p => p.id === productId);
  if (!product || !product.available) return;

  const existing = state.cart.find(c => c.id === productId);
  if (existing) {
    state.cart = state.cart.filter(c => c.id !== productId);
    showToast('Убрано из корзины');
  } else {
    state.cart.push({ ...product, qty: 1 });
    showToast('Добавлено в корзину ✓', 'success');
  }
  updateCartUI();
}

function changeQty(productId, delta) {
  const item = state.cart.find(c => c.id === productId);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) {
    state.cart = state.cart.filter(c => c.id !== productId);
  }
  updateCartUI();
  renderCartItems();
}

function updateCartUI() {
  const totalItems = state.cart.reduce((s, c) => s + c.qty, 0);
  const badge = document.getElementById('cartBadge');
  const stickyCart = document.getElementById('stickyCart');
  const stickyTotal = document.getElementById('stickyCartTotal');
  const stickyCount = document.getElementById('stickyCartCount');
  const checkoutBtn = document.getElementById('checkoutBtn');

  // Badge
  if (totalItems > 0) {
    badge.textContent = totalItems;
    badge.classList.remove('hidden');
    stickyCart.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
    stickyCart.classList.add('hidden');
  }

  // Sticky cart
  const subtotal = state.cart.reduce((s, c) => s + c.price * c.qty, 0);
  const final = Math.max(0, subtotal - state.discount);
  stickyTotal.textContent = `${final} сом`;
  stickyCount.textContent = totalItems;

  // Checkout button
  if (checkoutBtn) checkoutBtn.disabled = state.cart.length === 0;
}

function openBuyModal(productId) {
  const product = state.products.find(p => p.id === productId);
  if (!product || !product.available) return;

  state.buyProductId = productId;
  const categoryName = getCategoryName(product.categoryId);
  const summary = document.getElementById('buyOrderSummary');
  summary.innerHTML = `
    <div><strong>${escapeHtml(categoryName)}</strong></div>
    <div class="buy-summary-row">${escapeHtml(product.description || product.name)}</div>
    <div class="buy-summary-row">${formatProductPriceHtml(product)}</div>
  `;

  document.getElementById('buyPhone').value = '';
  document.getElementById('buyAddress').value = '';
  document.getElementById('buyComment').value = '';
  openModal('buyOrderModal');
}

async function submitBuyOrder(e) {
  e.preventDefault();
  const product = state.products.find(p => p.id === state.buyProductId);
  if (!product) return;

  const phone = document.getElementById('buyPhone').value.trim();
  const address = document.getElementById('buyAddress').value.trim();
  const comment = document.getElementById('buyComment').value.trim();
  if (!phone || !address) {
    showToast('Заполните телефон и адрес', 'error');
    return;
  }

  const btn = document.getElementById('buySubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Отправка...'; }

  const tgUser = tg?.initDataUnsafe?.user;
  const categoryName = getCategoryName(product.categoryId);
  const orderData = {
    userId: tgUser?.id || null,
    userName: tgUser ? `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim() : 'Аноним',
    username: tgUser?.username || '',
    phone,
    address,
    comment,
    categoryName,
    categoryId: product.categoryId,
    items: [{
      id: product.id,
      name: product.name,
      description: product.description || product.name,
      categoryId: product.categoryId,
      categoryName,
      price: product.price,
      qty: 1
    }],
    total: product.price,
    finalTotal: product.price,
    discount: 0
  };

  try {
    await submitOrderViaAPI(orderData);
    closeModal('buyOrderModal');
    state.buyProductId = null;
    showToast('Заказ оформлен ✓', 'success');
    redirectToBot();
  } catch (err) {
    showToast('Ошибка: ' + (err.message || 'не удалось оформить заказ'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Подтвердить заказ'; }
  }
}

function redirectToBot() {
  const hasTgUser = !!(tg?.initDataUnsafe?.user?.id);
  const botUrl = hasTgUser
    ? 'https://t.me/Red1shopbot'
    : 'https://t.me/Red1shopbot?start=welcome';
  if (tg && typeof tg.openTelegramLink === 'function') {
    tg.openTelegramLink(botUrl);
    setTimeout(() => { try { tg.close(); } catch {} }, 350);
  } else {
    window.open(botUrl, '_blank');
  }
}

function openCart() {
  renderCartItems();
  openModal('cartModal');
}

function renderCartItems() {
  const container = document.getElementById('cartItems');
  const empty = document.getElementById('cartEmpty');
  const footer = document.getElementById('cartFooter');
  const subtotalEl = document.getElementById('cartSubtotal');
  const totalEl = document.getElementById('cartTotal');
  const discountRow = document.getElementById('discountRow');
  const discountDisplay = document.getElementById('cartDiscountDisplay');
  const checkoutBtn = document.getElementById('checkoutBtn');

  container.innerHTML = '';

  if (state.cart.length === 0) {
    empty.classList.remove('hidden');
    footer.style.display = 'none';
    return;
  }

  empty.classList.add('hidden');
  footer.style.display = '';

  state.cart.forEach(item => {
    const el = document.createElement('div');
    el.className = 'cart-item';
    el.innerHTML = `
      <img class="cart-item-photo" src="${item.photo}" alt="${item.name}"
        onerror="this.src='/img/placeholder.svg'">
      <div class="cart-item-info">
        <div class="cart-item-name">${item.name}</div>
        <div class="cart-item-price">${item.price * item.qty} сом</div>
      </div>
      <div class="cart-item-qty">
        <button class="qty-btn" onclick="changeQty(${item.id}, -1)">−</button>
        <span class="qty-value">${item.qty}</span>
        <button class="qty-btn" onclick="changeQty(${item.id}, 1)">+</button>
      </div>
    `;
    container.appendChild(el);
  });

  const subtotal = state.cart.reduce((s, c) => s + c.price * c.qty, 0);
  const final = Math.max(0, subtotal - state.discount);

  subtotalEl.textContent = `${subtotal} сом`;
  totalEl.textContent = `${final} сом`;
  checkoutBtn.disabled = false;

  if (state.discount > 0) {
    discountRow.classList.remove('hidden');
    discountDisplay.textContent = `−${state.discount} сом`;
  } else {
    discountRow.classList.add('hidden');
  }
}

// ─── Checkout ─────────────────────────────────────────────────────────────────
async function checkout() {
  if (state.cart.length === 0) {
    showToast('Корзина пуста', 'error');
    return;
  }

  const tgUser = tg?.initDataUnsafe?.user;
  const subtotal = state.cart.reduce((s, c) => s + c.price * c.qty, 0);
  const final = Math.max(0, subtotal - state.discount);

  const orderData = {
    userId: tgUser?.id || null,
    userName: tgUser ? `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim() : 'Аноним',
    username: tgUser?.username || '',
    items: state.cart.map(c => ({ id: c.id, name: c.name, price: c.price, qty: c.qty })),
    total: subtotal,
    discount: state.discount,
    finalTotal: final
  };

  // Close cart, reset state
  closeModal('cartModal');

  // If Telegram Web App is available, use sendData (bot receives the order)
  if (tg && tg.sendData && tg.initDataUnsafe?.user) {
    try {
      tg.sendData(JSON.stringify(orderData));
    } catch {
      // sendData failed — use API fallback
      await submitOrderViaAPI(orderData);
    }
    // Reset cart after sendData
    const savedCart = [...state.cart];
    state.cart = [];
    state.discount = 0;
    localStorage.removeItem('redshop_discount');
    updateCartUI();
    showOrderSuccess(orderData, savedCart);
  } else {
    // Dev mode or no TG context — use API directly
    await submitOrderViaAPI(orderData);
    const savedCart = [...state.cart];
    state.cart = [];
    state.discount = 0;
    localStorage.removeItem('redshop_discount');
    updateCartUI();
    showOrderSuccess(orderData, savedCart);
  }
}

async function submitOrderViaAPI(orderData) {
  const res = await api('POST', '/orders', orderData);
  return res;
}

function showOrderSuccess(orderData, cartItems) {
  // Build order summary
  const infoEl = document.getElementById('successOrderInfo');
  if (infoEl && cartItems && cartItems.length > 0) {
    const lines = cartItems.map(c => `• ${c.name} ×${c.qty} — ${c.price * c.qty} сом`).join('<br>');
    const discountLine = orderData.discount > 0
      ? `<br><span style="color:#4ade80">🎁 Скидка: −${orderData.discount} сом</span>` : '';
    infoEl.innerHTML = `${lines}${discountLine}<br><strong style="color:#fff">Итого: ${orderData.finalTotal} сом</strong>`;
  }

  // Reset success animation
  const checkmark = document.getElementById('successCheckmark');
  if (checkmark) {
    checkmark.style.animation = 'none';
    void checkmark.offsetHeight; // reflow
    checkmark.style.animation = '';
  }

  openModal('orderSuccessModal');
}

function openBotChat() {
  closeModal('orderSuccessModal');
  redirectToBot();
}

// ═══════════════════════════════════════════════════════════════
// ROULETTE — Neon vibrant redesign
// ═══════════════════════════════════════════════════════════════

// Each segment: 4-stop gradient colours + neon border colour
const SEGMENTS = [
  {
    label: '50', sub: 'сом', discount: 50, degrees: 270,
    // Fire: bright orange → red → deep crimson
    c0: '#ff8c00', c1: '#ff3300', c2: '#cc0000', c3: '#7a0000',
    textDark: false, neon: '#ff4400'
  },
  {
    label: '100', sub: 'сом', discount: 100, degrees: 54,
    // Purple: violet → deep purple
    c0: '#dd00ff', c1: '#9900cc', c2: '#660099', c3: '#330055',
    textDark: false, neon: '#cc00ff'
  },
  {
    label: '150', sub: 'сом', discount: 150, degrees: 36,
    // Gold jackpot: white → gold → amber
    c0: '#ffffff', c1: '#ffe033', c2: '#ffaa00', c3: '#cc6600',
    textDark: true, neon: '#ffd700'
  }
];

// ─── Web Audio ──────────────────────────────────────────────────────────────
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// Single tick sound (used during spin)
function playTick(pitch = 600, vol = 0.18) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.connect(g); g.connect(ctx.destination);
    osc.type = 'square';
    osc.frequency.value = pitch;
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.04);
  } catch {}
}

// Win fanfare: ascending arpeggio
function playWinSound() {
  try {
    const ctx = getAudioCtx();
    const notes = [523, 659, 784, 1047, 1319]; // C E G C E
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.connect(g); g.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.11;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t); osc.stop(t + 0.35);
    });
  } catch {}
}

function checkSpinStatus() {
  const lastSpin = localStorage.getItem('redshop_lastSpin');
  const today = new Date().toDateString();
  const spinBtn = document.getElementById('spinBtn');
  const cooldown = document.getElementById('spinCooldown');

  if (lastSpin === today) {
    if (spinBtn) spinBtn.classList.add('hidden');
    if (cooldown) cooldown.classList.remove('hidden');
  }
}

function checkExistingDiscount() {
  const saved = localStorage.getItem('redshop_discount');
  const lastSpin = localStorage.getItem('redshop_lastSpin');
  const today = new Date().toDateString();

  if (saved && lastSpin === today) {
    applyDiscount(parseInt(saved), false);
  }
}

function openRoulette() {
  openModal('rouletteModal');
  // Draw initial wheel
  requestAnimationFrame(() => drawWheel(state.wheelRotation));
}

function drawWheel(rotation, glowIntensity = 1) {
  const canvas = document.getElementById('wheelCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(cx, cy) - 12;

  ctx.clearRect(0, 0, W, H);

  // ── Neon outer glow ring (multi-layer) ──
  const gi = Math.max(0.3, glowIntensity);
  [
    { r: R + 22, a: 0.08 * gi },
    { r: R + 14, a: 0.18 * gi },
    { r: R + 6,  a: 0.35 * gi }
  ].forEach(({ r, a }) => {
    const halo = ctx.createRadialGradient(cx, cy, R - 4, cx, cy, r);
    halo.addColorStop(0, `rgba(255,80,0,0)`);
    halo.addColorStop(0.6, `rgba(255,100,0,${a * 0.6})`);
    halo.addColorStop(1,   `rgba(255,200,0,${a})`);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.fillStyle = halo; ctx.fill();
  });

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);

  let startAngle = -Math.PI / 2;

  SEGMENTS.forEach(seg => {
    const angle    = (seg.degrees / 360) * 2 * Math.PI;
    const midAngle = startAngle + angle / 2;

    // 4-stop radial gradient from center outward
    const gx1 = Math.cos(midAngle) * R * 0.12, gy1 = Math.sin(midAngle) * R * 0.12;
    const gx2 = Math.cos(midAngle) * R * 0.98, gy2 = Math.sin(midAngle) * R * 0.98;
    const grad = ctx.createLinearGradient(gx1, gy1, gx2, gy2);
    grad.addColorStop(0,    seg.c0);
    grad.addColorStop(0.3,  seg.c1);
    grad.addColorStop(0.65, seg.c2);
    grad.addColorStop(1,    seg.c3);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, startAngle, startAngle + angle);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Sector dividers — black with slight glow
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.95)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Inner radial light burst (highlight near centre)
    const burst = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.5);
    burst.addColorStop(0,   'rgba(255,255,255,0.22)');
    burst.addColorStop(0.5, 'rgba(255,255,255,0.06)');
    burst.addColorStop(1,   'rgba(255,255,255,0)');
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R * 0.5, startAngle, startAngle + angle);
    ctx.closePath();
    ctx.fillStyle = burst;
    ctx.fill();

    // ── Text ──
    const tr = R * 0.62;
    const tx = Math.cos(midAngle) * tr;
    const ty = Math.sin(midAngle) * tr;
    const textCol   = seg.textDark ? '#1a1a1a' : '#ffffff';
    const glowCol   = seg.textDark ? 'rgba(0,0,0,0.4)' : seg.neon;

    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(midAngle + Math.PI / 2);

    const bigFont = seg.degrees >= 200 ? 32 : seg.degrees >= 50 ? 24 : 18;
    const subFont = seg.degrees >= 200 ? 14 : seg.degrees >= 50 ? 11 : 9;
    const bigOff  = seg.degrees >= 200 ? -11 : -8;
    const subOff  = seg.degrees >= 200 ?  14 : seg.degrees >= 50 ? 11 : 9;

    // Number with neon text shadow
    ctx.shadowColor = glowCol; ctx.shadowBlur = 12;
    ctx.fillStyle = textCol;
    ctx.font = `900 ${bigFont}px Inter, Arial, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(seg.label, 0, bigOff);
    // Second pass for extra punch
    ctx.shadowBlur = 6;
    ctx.fillText(seg.label, 0, bigOff);

    // "сом"
    ctx.shadowBlur = 6;
    ctx.font = `700 ${subFont}px Inter, Arial, sans-serif`;
    ctx.fillStyle = seg.textDark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.9)';
    ctx.fillText(seg.sub, 0, subOff);

    ctx.restore();
    startAngle += angle;
  });

  // ── Tick marks on the rim ──
  for (let deg = 0; deg < 360; deg += 5) {
    const rad   = deg * Math.PI / 180;
    const major = deg % 30 === 0;
    const len   = major ? 9 : 5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(rad) * (R - len), Math.sin(rad) * (R - len));
    ctx.lineTo(Math.cos(rad) * R,          Math.sin(rad) * R);
    ctx.strokeStyle = major ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth   = major ? 2.5 : 1;
    ctx.stroke();
  }

  // ── Diamond markers at sector boundaries ──
  let bAngle = -Math.PI / 2;
  SEGMENTS.forEach(seg => {
    const dx = Math.cos(bAngle) * (R + 2);
    const dy = Math.sin(bAngle) * (R + 2);
    ctx.save();
    ctx.translate(dx, dy);
    ctx.rotate(bAngle);
    ctx.shadowColor = '#ffd700'; ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.moveTo(0,-6); ctx.lineTo(3.5,0); ctx.lineTo(0,6); ctx.lineTo(-3.5,0);
    ctx.closePath();
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.restore();
    bAngle += (seg.degrees / 360) * 2 * Math.PI;
  });

  ctx.restore();

  // ── Neon outer border (two layers) ──
  ctx.shadowColor = '#ff4400'; ctx.shadowBlur = 18 * gi;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.strokeStyle = '#ff6600'; ctx.lineWidth = 5; ctx.stroke();
  ctx.shadowColor = '#ffcc00'; ctx.shadowBlur = 8 * gi;
  ctx.strokeStyle = 'rgba(255,220,0,0.6)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.shadowBlur = 0;

  // ── Metallic sheen ring ──
  const metal = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  metal.addColorStop(0,   'rgba(255,255,255,0.3)');
  metal.addColorStop(0.5, 'rgba(255,255,255,0.05)');
  metal.addColorStop(1,   'rgba(255,255,255,0.2)');
  ctx.beginPath(); ctx.arc(cx, cy, R + 2, 0, 2 * Math.PI);
  ctx.strokeStyle = metal; ctx.lineWidth = 3; ctx.stroke();

  // ── Hub shadow ──
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 16;
  ctx.beginPath(); ctx.arc(cx, cy, 30, 0, 2 * Math.PI);
  ctx.fillStyle = '#050505'; ctx.fill();
  ctx.shadowBlur = 0;

  // Hub neon ring
  ctx.shadowColor = '#ff4400'; ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.arc(cx, cy, 28, 0, 2 * Math.PI);
  ctx.strokeStyle = '#ff6600'; ctx.lineWidth = 3; ctx.stroke();
  ctx.shadowBlur = 0;

  // Hub gradient fill
  const hub = ctx.createRadialGradient(cx - 6, cy - 6, 2, cx, cy, 26);
  hub.addColorStop(0, '#ff7700'); hub.addColorStop(0.5, '#cc3300'); hub.addColorStop(1, '#550000');
  ctx.beginPath(); ctx.arc(cx, cy, 26, 0, 2 * Math.PI);
  ctx.fillStyle = hub; ctx.fill();

  // Hub inner highlight
  ctx.beginPath(); ctx.arc(cx - 7, cy - 7, 8, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fill();

  // Hub centre dot
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 2 * Math.PI);
  ctx.fillStyle = '#ff9900'; ctx.fill();
}

function spinWheel() {
  const lastSpin = localStorage.getItem('redshop_lastSpin');
  const today = new Date().toDateString();

  if (lastSpin === today) {
    showToast('Вы уже крутили рулетку сегодня!', 'error');
    return;
  }
  if (state.spinning) return;

  state.spinning = true;
  const canvas = document.getElementById('wheelCanvas');
  if (canvas) canvas.classList.add('spinning');
  document.getElementById('spinBtn').disabled = true;
  document.getElementById('spinResultBox')?.classList.add('hidden');
  document.getElementById('wheelWinGlow')?.classList.remove('active');

  // Weighted probability
  const rand = Math.random() * 100;
  let resultIdx;
  if (rand < 75) resultIdx = 0;
  else if (rand < 90) resultIdx = 1;
  else resultIdx = 2;

  const seg = SEGMENTS[resultIdx];

  // Cumulative angles (degrees from 12 o'clock, clockwise)
  const cumDeg = [];
  let cum = 0;
  SEGMENTS.forEach(s => { cumDeg.push(cum); cum += s.degrees; });

  // Pick a random point inside the winning segment
  const targetDeg = cumDeg[resultIdx] + seg.degrees * (0.15 + Math.random() * 0.7);
  const extraSpins = 6 + Math.floor(Math.random() * 3);
  const finalDeg = -(extraSpins * 360 + targetDeg);
  const finalRad = finalDeg * Math.PI / 180;

  const startRot = state.wheelRotation;
  const startTime = performance.now();
  const duration = 5000;
  let lastTickAngle = 0;
  const tickInterval = 30; // degrees between ticks (gets bigger = slower = more spread)

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 5);
  }

  function animate(now) {
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);
    const eased = easeOut(t);
    state.wheelRotation = startRot + (finalRad - startRot) * eased;

    // Tick sound: fire when wheel crosses a tick mark during fast spin
    const currentDeg = Math.abs(state.wheelRotation * 180 / Math.PI) % 360;
    const speed = 1 - t; // speed factor (1 = fast, 0 = stopped)
    const dynInterval = tickInterval + (1 - speed) * 120; // intervals widen as it slows
    if (Math.abs(currentDeg - lastTickAngle) >= dynInterval) {
      lastTickAngle = currentDeg;
      const pitch = 300 + speed * 900;
      playTick(pitch, 0.08 + speed * 0.15);
    }

    // Glow intensity pulses with speed
    drawWheel(state.wheelRotation, 0.4 + speed * 0.8);

    if (t < 1) {
      requestAnimationFrame(animate);
    } else {
      state.spinning = false;
      if (canvas) canvas.classList.remove('spinning');
      state.wheelRotation = finalRad % (2 * Math.PI);
      drawWheel(state.wheelRotation, 1.5); // bright flash on stop

      localStorage.setItem('redshop_lastSpin', today);
      localStorage.setItem('redshop_discount', seg.discount);

      // Win glow + sound
      const glowEl = document.getElementById('wheelWinGlow');
      if (glowEl) glowEl.classList.add('active');
      playWinSound();

      // Show result popup
      const resultBox = document.getElementById('spinResultBox');
      const resultText = document.getElementById('spinResultText');
      const resultIcon = document.getElementById('spinResultIcon');
      const resultSub  = document.getElementById('spinResultSub');
      if (resultBox) {
        const emojis = { 50: '🎉', 100: '🎊', 150: '🤩' };
        resultIcon.textContent = emojis[seg.discount] || '🎉';
        resultText.textContent = `${seg.discount} сом скидки!`;
        if (resultSub) resultSub.textContent = 'Скидка применена к вашему заказу';
        resultBox.classList.remove('hidden');
        launchSparkles(resultBox);
        launchConfetti();
      }

      applyDiscount(seg.discount, false);
      document.getElementById('spinBtn').classList.add('hidden');
      document.getElementById('spinCooldown').classList.remove('hidden');
      showToast(`🎉 Скидка ${seg.discount} сом применена!`, 'success');
    }
  }

  requestAnimationFrame(animate);
}

function launchSparkles(container) {
  const sparkleEl = container.querySelector('.spin-sparkles');
  if (!sparkleEl) return;
  sparkleEl.innerHTML = '';
  const colors = ['#ff4400','#ff8800','#ffd700','#cc00ff','#ffffff','#ff3399'];
  for (let i = 0; i < 24; i++) {
    const s = document.createElement('div');
    s.className = 'sparkle';
    const angle = Math.random() * 360;
    const dist  = 50 + Math.random() * 100;
    s.style.cssText = `
      left: ${40 + Math.random() * 20}%;
      top:  ${30 + Math.random() * 30}%;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      width: ${4 + Math.random() * 7}px;
      height: ${4 + Math.random() * 7}px;
      --dx: ${Math.cos(angle * Math.PI/180) * dist}px;
      --dy: ${Math.sin(angle * Math.PI/180) * dist}px;
      --dur: ${0.5 + Math.random() * 0.9}s;
      animation-delay: ${Math.random() * 0.25}s;
    `;
    sparkleEl.appendChild(s);
  }
}

// Full-screen confetti shower on win
function launchConfetti() {
  const colors = ['#ff4400','#ff8800','#ffd700','#cc00ff','#00ccff','#ff3399','#ffffff','#44ff44'];
  const modal = document.getElementById('rouletteModal');
  if (!modal) return;

  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    const size  = 5 + Math.random() * 9;
    const isRect = Math.random() > 0.4;
    piece.style.cssText = `
      left: ${Math.random() * 100}%;
      top: -12px;
      width: ${size}px;
      height: ${isRect ? size * 0.5 : size}px;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      border-radius: ${isRect ? '2px' : '50%'};
      animation-delay: ${Math.random() * 0.8}s;
      animation-duration: ${1.0 + Math.random() * 1.2}s;
      --spin: ${Math.random() > 0.5 ? '' : '-'}${360 + Math.random() * 720}deg;
      --dx: ${(Math.random() - 0.5) * 120}px;
    `;
    modal.appendChild(piece);
    setTimeout(() => piece.remove(), 3000);
  }
}

function applyDiscount(amount, closeRoulette = false) {
  state.discount = amount;
  const banner = document.getElementById('discountBanner');
  const amountEl = document.getElementById('discountBannerAmount');
  if (banner && amountEl) {
    amountEl.textContent = amount;
    banner.classList.remove('hidden');
  }
  updateCartUI();
  if (closeRoulette) closeModal('rouletteModal');
}

function removeDiscount() {
  state.discount = 0;
  localStorage.removeItem('redshop_discount');
  localStorage.removeItem('redshop_lastSpin'); // allow re-spin if discount removed? No — keep it.
  localStorage.setItem('redshop_lastSpin', new Date().toDateString()); // keep spin used
  document.getElementById('discountBanner').classList.add('hidden');
  updateCartUI();
  showToast('Скидка убрана');
}

// ═══════════════════════════════════════════════════════════════
// ADMIN AUTH — по Telegram ID (без пароля)
// ═══════════════════════════════════════════════════════════════

async function initAdminCheck() {
  const userId = tg?.initDataUnsafe?.user?.id;
  const initData = tg?.initData;

  // Primary: cryptographic initData verification via server
  if (initData) {
    try {
      const res = await fetch('/api/check-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData })
      });
      const data = await res.json();
      if (data.isAdmin) {
        state.isAdmin = true;
        state.adminUserId = data.userId || userId;
        state.telegramInitData = initData;
        showAdminButton();
        return;
      }
    } catch {}
  }

  // Fallback: simple userId check (works in dev without full TG context)
  if (userId) {
    try {
      const res = await fetch(`/api/check-admin?userId=${userId}`);
      const data = await res.json();
      if (data.isAdmin) {
        state.isAdmin = true;
        state.adminUserId = userId;
        state.telegramInitData = initData || '';
        showAdminButton();
      }
    } catch {}
  }
}

function showAdminButton() {
  const btn = document.getElementById('adminBtn');
  if (btn) {
    btn.classList.remove('hidden');
    btn.style.animation = 'badgePop 0.4s ease';
  }
}

function openAdminPanel() {
  if (!state.isAdmin) return;
  showAdminPanel();
}

// Legacy openAdminLogin kept for HTML references
function openAdminLogin() { openAdminPanel(); }

async function loginAdmin() {
  if (state.isAdmin) {
    closeModal('adminLoginModal');
    showAdminPanel();
  } else {
    document.getElementById('adminLoginError').classList.remove('hidden');
  }
}

function showAdminPanel() {
  Object.values(MAIN_TAB_VIEWS).forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
  setBottomNavVisible(false);
  document.getElementById('adminPanel').classList.remove('hidden');
  switchAdminTab('products');
}

function refreshShopView() {
  if (document.getElementById('shopView').classList.contains('hidden')) return;
  if (state.selectedCategoryId) renderCatalog();
  else showCategoriesView();
}

function logoutAdmin() {
  state.adminPassword = null;
  document.getElementById('adminPanel').classList.add('hidden');
  setBottomNavVisible(true);
  switchMainTab(state.currentMainTab || 'catalog');
  refreshShopView();
  showToast('Выход из админ панели');
}

// ═══════════════════════════════════════════════════════════════
// ADMIN TABS
// ═══════════════════════════════════════════════════════════════

function switchAdminTab(tab) {
  state.currentAdminTab = tab;

  // Update nav buttons
  document.querySelectorAll('.admin-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Show/hide tabs
  document.querySelectorAll('.admin-tab').forEach(el => {
    el.classList.toggle('hidden', el.id !== `tab-${tab}`);
  });

  // Load tab data
  if (tab === 'products') loadAdminProducts();
  else if (tab === 'orders') loadAdminOrders();
  else if (tab === 'messages') loadMessages();
  else if (tab === 'stats') loadStats();
}

// ═══════════════════════════════════════════════════════════════
// ADMIN — PRODUCTS & CATEGORIES
// ═══════════════════════════════════════════════════════════════

function populateCategorySelects() {
  const addSelect = document.getElementById('addProductCategory');
  if (!addSelect) return;
  const current = addSelect.value;
  addSelect.innerHTML = '<option value="">Выберите позицию</option>' +
    state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (current) addSelect.value = current;
}

async function loadAdminProducts() {
  try {
    const [products, categories] = await Promise.all([
      api('GET', '/products'),
      api('GET', '/categories')
    ]);
    state.products = products;
    state.categories = categories;
    populateCategorySelects();
    renderAdminCategories();
    renderAdminProducts();
    refreshShopView();
  } catch (err) {
    showToast('Ошибка загрузки товаров', 'error');
  }
}

function renderAdminCategories() {
  const list = document.getElementById('adminCategoriesList');
  if (!list) return;
  list.innerHTML = '';

  if (state.categories.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:16px"><div>Нет позиций</div></div>';
    return;
  }

  state.categories.forEach(cat => {
    const count = getCategoryProductCount(cat.id);
    const photoSrc = normalizePhotoSrc(cat.photo);
    const item = document.createElement('div');
    item.className = 'admin-category-item';
    item.id = `adminCategory_${cat.id}`;
    item.innerHTML = `
      <img class="admin-category-photo" src="${photoSrc}" alt="${escapeHtml(cat.name)}"
        onclick="changeCategoryPhoto(${cat.id})" title="Нажмите чтобы изменить фото"
        onerror="this.src='/img/placeholder.svg'">
      <div class="admin-category-name" id="catNameDisplay_${cat.id}">${escapeHtml(cat.name)}</div>
      <span class="admin-category-count">${count} вкус(ов)</span>
      <div id="catEditRow_${cat.id}" class="inline-edit-row hidden">
        <input type="text" class="form-input" id="catNameInput_${cat.id}" value="${escapeHtml(cat.name)}">
        <button class="btn-primary btn-sm" onclick="saveCategoryName(${cat.id})">✓</button>
        <button class="btn-sm btn-sm-grey" onclick="cancelCategoryEdit(${cat.id})">✕</button>
      </div>
      <button class="btn-sm btn-sm-grey" onclick="changeCategoryPhoto(${cat.id})">🖼 Фото</button>
      <button class="btn-sm btn-sm-red" onclick="toggleCategoryEdit(${cat.id})">✏️</button>
      <button class="btn-sm btn-sm-red" onclick="deleteCategory(${cat.id})">🗑</button>
    `;
    list.appendChild(item);
  });
}

async function addCategory(e) {
  e.preventDefault();
  const form = e.target;
  const name = form.elements['name']?.value?.trim() || document.getElementById('addCategoryName')?.value?.trim();
  if (!name) { showToast('Введите название позиции', 'error'); return; }

  const fd = new FormData();
  fd.append('name', name);
  const fileInput = document.getElementById('addCategoryPhoto');
  if (fileInput?.files[0]) fd.append('photo', fileInput.files[0]);

  try {
    await adminFormFetch('POST', `${API}/categories`, fd);
    showToast(`Позиция «${name}» добавлена ✓`, 'success');
    form.reset();
    if (fileInput) fileInput.value = '';
    const preview = document.getElementById('addCategoryPhotoPreview');
    const photoName = document.getElementById('addCategoryPhotoName');
    if (preview) preview.textContent = '📷';
    if (photoName) photoName.textContent = 'Выберите фото (необяз.)';
    await loadAdminProducts();
    if (!state.selectedCategoryId) showCategoriesView();
    else await loadProducts();
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  }
}

function previewAddCategoryPhoto(input) {
  if (!input.files[0]) return;
  const name = input.files[0].name;
  document.getElementById('addCategoryPhotoName').textContent =
    name.length > 20 ? name.slice(0, 20) + '...' : name;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('addCategoryPhotoPreview').innerHTML =
      `<img src="${e.target.result}" style="width:36px;height:36px;object-fit:cover;border-radius:6px;">`;
  };
  reader.readAsDataURL(input.files[0]);
}

function toggleCategoryEdit(id) {
  document.getElementById(`catEditRow_${id}`)?.classList.toggle('hidden');
  document.getElementById(`catNameDisplay_${id}`)?.classList.toggle('hidden');
}

function cancelCategoryEdit(id) {
  document.getElementById(`catEditRow_${id}`)?.classList.add('hidden');
  document.getElementById(`catNameDisplay_${id}`)?.classList.remove('hidden');
  const cat = state.categories.find(c => c.id === id);
  const input = document.getElementById(`catNameInput_${id}`);
  if (cat && input) input.value = cat.name;
}

async function saveCategoryName(id) {
  const input = document.getElementById(`catNameInput_${id}`);
  const name = input?.value.trim();
  if (!name) { showToast('Введите название', 'error'); return; }
  try {
    await api('PUT', `/categories/${id}`, { name }, true);
    showToast('Позиция переименована ✓', 'success');
    await loadAdminProducts();
    if (state.selectedCategoryId === id) {
      document.getElementById('catalogTitle').textContent = name;
    }
    if (!state.selectedCategoryId) showCategoriesView();
    else if (state.selectedCategoryId) renderCatalog();
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  }
}

async function deleteCategory(id) {
  const cat = state.categories.find(c => c.id === id);
  const count = getCategoryProductCount(id);
  if (count > 0) {
    showToast(`Нельзя удалить «${cat?.name}»: в ней ${count} товар(ов)`, 'error');
    return;
  }
  if (!confirm(`Удалить позицию «${cat?.name}»?`)) return;
  try {
    await api('DELETE', `/categories/${id}`, null, true);
    showToast('Позиция удалена', 'success');
    await loadAdminProducts();
    if (state.selectedCategoryId === id) showCategoriesView();
    else if (!state.selectedCategoryId) showCategoriesView();
    else renderCatalog();
  } catch (err) {
    showToast(err.message || 'Ошибка удаления', 'error');
  }
}

function renderAdminProducts() {
  const list = document.getElementById('adminProductsList');
  list.innerHTML = '';

  if (state.products.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📦</div><div>Нет товаров</div></div>';
    return;
  }

  state.products.forEach(product => {
    const item = document.createElement('div');
    item.className = `admin-product-item${!product.available ? ' unavailable' : ''}`;
    item.id = `adminProduct_${product.id}`;
    item.innerHTML = `
      <img class="admin-product-photo" src="${product.photo}" alt="${product.name}"
        onerror="this.src='/img/placeholder.svg'"
        onclick="changeProductPhoto(${product.id})" title="Нажмите чтобы изменить фото">

      <div class="admin-product-body">
        <div class="admin-product-name">${product.name}</div>
        <div class="admin-product-meta">
          <span class="admin-product-price">${product.oldPrice && product.oldPrice > product.price
            ? `<span class="price-old">${product.oldPrice}</span> ${product.price} сом`
            : `${product.price} сом`}</span>
          <span class="status-pill available">${escapeHtml(getCategoryName(product.categoryId))}</span>
          <span class="admin-product-sales">Продано: ${product.sales || 0}</span>
          <span class="status-pill ${product.available ? 'available' : 'unavailable'}">
            ${product.available ? 'В наличии' : 'Нет в наличии'}
          </span>
        </div>
        <div class="form-group" style="margin-top:8px">
          <label style="font-size:11px;color:var(--grey)">Позиция</label>
          <select class="form-input" id="catSelect_${product.id}" onchange="changeProductCategory(${product.id}, this.value)">
            ${state.categories.map(c =>
              `<option value="${c.id}" ${c.id === product.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
            ).join('')}
          </select>
        </div>
        <div id="editRow_${product.id}" class="inline-edit-row hidden">
          <input type="number" class="form-input" id="priceInput_${product.id}"
            value="${product.price}" placeholder="Цена" min="1">
          <input type="number" class="form-input" id="oldPriceInput_${product.id}"
            value="${product.oldPrice || ''}" placeholder="Старая цена" min="1">
          <button class="btn-primary btn-sm" onclick="savePrice(${product.id})">✓</button>
          <button class="btn-sm btn-sm-grey" onclick="cancelEdit(${product.id})">✕</button>
        </div>
        <div class="admin-product-actions">
          <button class="btn-sm btn-sm-red" onclick="toggleEditPrice(${product.id})">✏️ Цена</button>
          <button class="btn-sm btn-sm-grey" onclick="changeProductPhoto(${product.id})">🖼 Фото</button>
          <button class="btn-sm ${product.available ? 'btn-sm-grey' : 'btn-sm-green'}"
            onclick="toggleAvailability(${product.id})">
            ${product.available ? '🔴 Скрыть' : '🟢 Показать'}
          </button>
          <button class="btn-sm btn-sm-red" onclick="deleteProduct(${product.id})">🗑 Удалить</button>
        </div>
      </div>
    `;
    list.appendChild(item);
  });
}

function toggleEditPrice(id) {
  const row = document.getElementById(`editRow_${id}`);
  row.classList.toggle('hidden');
  if (!row.classList.contains('hidden')) {
    document.getElementById(`priceInput_${id}`).focus();
  }
}

function cancelEdit(id) {
  document.getElementById(`editRow_${id}`).classList.add('hidden');
}

async function savePrice(id) {
  const input = document.getElementById(`priceInput_${id}`);
  const oldInput = document.getElementById(`oldPriceInput_${id}`);
  const price = parseInt(input.value);
  if (!price || price < 1) { showToast('Введите корректную цену', 'error'); return; }

  try {
    const fd = new FormData();
    fd.append('price', price);
    const oldVal = oldInput?.value?.trim();
    fd.append('oldPrice', oldVal || '');
    await adminFormFetch('PUT', `${API}/products/${id}`, fd);
    showToast('Цена обновлена ✓', 'success');
    await loadAdminProducts();
    if (state.selectedCategoryId) renderCatalog();
  } catch {
    showToast('Ошибка обновления', 'error');
  }
}

async function changeProductCategory(id, categoryId) {
  try {
    const fd = new FormData();
    fd.append('categoryId', parseInt(categoryId));
    await adminFormFetch('PUT', `${API}/products/${id}`, fd);
    showToast('Позиция товара обновлена ✓', 'success');
    await loadAdminProducts();
    if (state.selectedCategoryId) renderCatalog();
    else showCategoriesView();
  } catch {
    showToast('Ошибка обновления позиции', 'error');
  }
}

// Hidden file input for product photo change
let photoChangeProductId = null;
const photoInput = document.createElement('input');
photoInput.type = 'file';
photoInput.accept = 'image/*';
photoInput.style.display = 'none';
document.body.appendChild(photoInput);
photoInput.addEventListener('change', async function() {
  if (!this.files[0] || !photoChangeProductId) return;
  const fd = new FormData();
  fd.append('photo', this.files[0]);
  try {
    await adminFormFetch('PUT', `${API}/products/${photoChangeProductId}`, fd);
    showToast('Фото обновлено ✓', 'success');
    await loadAdminProducts();
  } catch {
    showToast('Ошибка загрузки фото', 'error');
  }
  this.value = '';
  photoChangeProductId = null;
});

function changeProductPhoto(id) {
  photoChangeProductId = id;
  photoInput.click();
}

// Hidden file input for category photo change
let photoChangeCategoryId = null;
const categoryPhotoInput = document.createElement('input');
categoryPhotoInput.type = 'file';
categoryPhotoInput.accept = 'image/*';
categoryPhotoInput.style.display = 'none';
document.body.appendChild(categoryPhotoInput);
categoryPhotoInput.addEventListener('change', async function() {
  if (!this.files[0] || !photoChangeCategoryId) return;
  const fd = new FormData();
  fd.append('photo', this.files[0]);
  try {
    await adminFormFetch('PUT', `${API}/categories/${photoChangeCategoryId}`, fd);
    showToast('Фото позиции обновлено ✓', 'success');
    await loadAdminProducts();
  } catch {
    showToast('Ошибка загрузки фото', 'error');
  }
  this.value = '';
  photoChangeCategoryId = null;
});

function changeCategoryPhoto(id) {
  photoChangeCategoryId = id;
  categoryPhotoInput.click();
}

async function toggleAvailability(id) {
  const product = state.products.find(p => p.id === id);
  if (!product) return;
  try {
    const fd = new FormData();
    fd.append('available', !product.available);
    await adminFormFetch('PUT', `${API}/products/${id}`, fd);
    showToast(product.available ? 'Товар скрыт' : 'Товар доступен ✓', 'success');
    await loadAdminProducts();
  } catch {
    showToast('Ошибка', 'error');
  }
}

async function deleteProduct(id) {
  if (!confirm('Удалить товар? Это действие необратимо.')) return;
  try {
    await api('DELETE', `/products/${id}`, null, true);
    showToast('Товар удалён', 'success');
    await loadAdminProducts();
  } catch {
    showToast('Ошибка удаления', 'error');
  }
}

async function addProduct(e) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button[type="submit"]');

  // Validate
  const name  = form.elements['name']?.value?.trim();
  const price = parseInt(form.elements['price']?.value);
  const categoryId = form.elements['categoryId']?.value;
  if (!name)          { showToast('Введите название', 'error'); return; }
  if (!price || price < 1) { showToast('Введите цену', 'error'); return; }
  if (!categoryId) { showToast('Выберите позицию', 'error'); return; }

  const fd = new FormData();
  fd.append('name',  name);
  fd.append('price', price);
  fd.append('categoryId', categoryId);
  fd.append('description', form.elements['description']?.value?.trim() || '');
  const oldPrice = form.elements['oldPrice']?.value?.trim();
  if (oldPrice) fd.append('oldPrice', oldPrice);

  const fileInput = document.getElementById('addProductPhoto');
  if (fileInput?.files[0]) fd.append('photo', fileInput.files[0]);

  if (btn) { btn.disabled = true; btn.textContent = 'Сохранение...'; }

  try {
    const newProduct = await adminFormFetch('POST', `${API}/products`, fd);
    showToast(`"${newProduct.name}" добавлен ✓`, 'success');
    form.reset();
    if (fileInput) fileInput.value = '';
    const preview = document.getElementById('addProductPhotoPreview');
    const photoName = document.getElementById('addProductPhotoName');
    if (preview) preview.textContent = '📷';
    if (photoName) photoName.textContent = 'Выберите фото';
    // Refresh both admin list and shop catalog
    await loadAdminProducts();
    if (state.selectedCategoryId) renderCatalog();
    else showCategoriesView();
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '➕ Добавить товар'; }
  }
}

function previewAddPhoto(input) {
  if (!input.files[0]) return;
  const name = input.files[0].name;
  document.getElementById('addProductPhotoName').textContent = name.length > 20 ? name.slice(0,20)+'...' : name;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('addProductPhotoPreview').innerHTML = `<img src="${e.target.result}" style="width:36px;height:36px;object-fit:cover;border-radius:6px;">`;
  };
  reader.readAsDataURL(input.files[0]);
}

// ═══════════════════════════════════════════════════════════════
// ADMIN — ORDERS
// ═══════════════════════════════════════════════════════════════

let allOrders = [];

async function loadAdminOrders() {
  try {
    allOrders = await api('GET', '/orders', null, true);
    renderOrders();
    updateNewOrdersBadge();
  } catch {
    showToast('Ошибка загрузки заказов', 'error');
  }
}

function filterOrders(filter) {
  state.ordersFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderOrders();
}

function renderOrders() {
  const list = document.getElementById('ordersList');
  const empty = document.getElementById('ordersEmpty');
  list.innerHTML = '';

  const filtered = state.ordersFilter === 'all'
    ? allOrders
    : allOrders.filter(o => o.status === state.ordersFilter);

  if (filtered.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  filtered.forEach(order => {
    const card = document.createElement('div');
    card.className = `order-card status-${order.status}`;
    const date = new Date(order.createdAt).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
    const itemsText = (order.items || []).map(i => {
      const flavor = i.description || i.name;
      const pos = i.categoryName || order.categoryName || '';
      return pos ? `${pos} — ${flavor} ×${i.qty || 1}` : `${flavor} ×${i.qty || 1}`;
    }).join(', ');
    const contactBlock = order.phone || order.address
      ? `<div class="order-contact">
          ${order.phone ? `<div>📞 ${escapeHtml(order.phone)}</div>` : ''}
          ${order.address ? `<div>📍 ${escapeHtml(order.address)}</div>` : ''}
          ${order.comment ? `<div>💬 ${escapeHtml(order.comment)}</div>` : ''}
        </div>`
      : '';

    card.innerHTML = `
      <div class="order-header">
        <span class="order-id">#${order.id}</span>
        <span class="order-date">${date}</span>
      </div>
      <div class="order-customer">
        👤 ${escapeHtml(order.userName || 'Аноним')}
        ${order.username ? `<span style="color:var(--grey);font-weight:400"> @${escapeHtml(order.username)}</span>` : ''}
      </div>
      <div class="order-items">📦 ${itemsText}</div>
      ${contactBlock}
      <div class="order-footer">
        <div>
          <div class="order-total">${order.finalTotal} сом</div>
          ${order.discount ? `<div class="order-discount">Скидка: −${order.discount} сом</div>` : ''}
        </div>
        <select class="order-status-select" onchange="updateOrderStatus(${order.id}, this.value)">
          <option value="new" ${order.status==='new'?'selected':''}>🆕 Новый</option>
          <option value="processing" ${order.status==='processing'?'selected':''}>⏳ В обработке</option>
          <option value="done" ${order.status==='done'?'selected':''}>✅ Выполнен</option>
        </select>
      </div>
    `;
    list.appendChild(card);
  });
}

async function updateOrderStatus(orderId, status) {
  try {
    await api('PUT', `/orders/${orderId}/status`, { status }, true);
    const order = allOrders.find(o => o.id === orderId);
    if (order) order.status = status;
    renderOrders();
    updateNewOrdersBadge();
    showToast('Статус обновлён ✓', 'success');
  } catch {
    showToast('Ошибка обновления статуса', 'error');
  }
}

function updateNewOrdersBadge() {
  const badge = document.getElementById('newOrdersBadge');
  const count = allOrders.filter(o => o.status === 'new').length;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ═══════════════════════════════════════════════════════════════
// ADMIN — MESSAGES
// ═══════════════════════════════════════════════════════════════

let allMessages = [];
let messagesPolling = null;

async function loadMessages() {
  try {
    allMessages = await api('GET', '/messages', null, true);
    renderUsersList();
  } catch {
    showToast('Ошибка загрузки сообщений', 'error');
  }
}

function renderUsersList() {
  const list = document.getElementById('usersList');
  const empty = document.getElementById('usersEmpty');
  list.innerHTML = '';

  if (allMessages.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  // Sort by last message time
  const sorted = [...allMessages].sort((a, b) => {
    const ta = a.lastMessage?.timestamp || '';
    const tb = b.lastMessage?.timestamp || '';
    return tb.localeCompare(ta);
  });

  sorted.forEach(conv => {
    const item = document.createElement('div');
    item.className = `user-list-item${state.currentChatUserId === conv.userId ? ' active' : ''}`;
    item.onclick = () => openChat(conv.userId, conv.user);
    const name = conv.user?.firstName || `User ${conv.userId}`;
    const preview = conv.lastMessage?.text || '';
    const time = conv.lastMessage?.timestamp
      ? new Date(conv.lastMessage.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : '';
    item.innerHTML = `
      <div style="display:flex;justify-content:space-between;">
        <div class="user-list-name">${name}</div>
        <span class="user-list-time">${time}</span>
      </div>
      <div class="user-list-preview">${preview.slice(0, 40)}</div>
    `;
    list.appendChild(item);
  });
}

async function openChat(userId, user) {
  state.currentChatUserId = userId;

  // Show chat content
  document.getElementById('chatPlaceholder').classList.add('hidden');
  document.getElementById('chatContent').classList.remove('hidden');
  document.getElementById('chatUserName').textContent = user?.firstName || `User ${userId}`;
  document.getElementById('chatUserId').textContent = `ID: ${userId}${user?.username ? ' · @'+user.username : ''}`;

  // Highlight in sidebar
  document.querySelectorAll('.user-list-item').forEach(el => el.classList.remove('active'));
  renderUsersList();

  // Load conversation
  await loadConversation(userId);

  // Start polling for new messages
  clearInterval(messagesPolling);
  messagesPolling = setInterval(() => loadConversation(userId), 5000);

  // On small screens, hide sidebar
  if (window.innerWidth < 400) {
    document.getElementById('messagesSidebar').classList.add('has-chat');
  }
}

async function loadConversation(userId) {
  try {
    const msgs = await api('GET', `/messages/${userId}`, null, true);
    renderConversation(msgs);
  } catch {}
}

function renderConversation(msgs) {
  const container = document.getElementById('chatMessages');
  container.innerHTML = '';
  msgs.forEach(msg => {
    const bubble = document.createElement('div');
    bubble.className = `message-bubble from-${msg.from === 'admin' ? 'admin' : 'user'}`;
    const time = msg.timestamp
      ? new Date(msg.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : '';
    bubble.innerHTML = `${escapeHtml(msg.text)}<div class="message-time">${time}</div>`;
    container.appendChild(bubble);
  });
  container.scrollTop = container.scrollHeight;
}

async function sendAdminMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !state.currentChatUserId) return;

  input.value = '';
  try {
    await api('POST', '/messages/send', { userId: state.currentChatUserId, text }, true);
    await loadConversation(state.currentChatUserId);
  } catch {
    showToast('Ошибка отправки', 'error');
    input.value = text;
  }
}

function closeChatWindow() {
  state.currentChatUserId = null;
  clearInterval(messagesPolling);
  document.getElementById('chatPlaceholder').classList.remove('hidden');
  document.getElementById('chatContent').classList.add('hidden');
  document.getElementById('messagesSidebar').classList.remove('has-chat');
}

// ═══════════════════════════════════════════════════════════════
// ADMIN — BROADCAST
// ═══════════════════════════════════════════════════════════════

function previewBroadcastPhoto(input) {
  if (!input.files[0]) return;
  const name = input.files[0].name;
  document.getElementById('broadcastPhotoName').textContent = name.length > 25 ? name.slice(0,25)+'...' : name;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('broadcastPhotoPreview').innerHTML = `<img src="${e.target.result}" style="width:36px;height:36px;object-fit:cover;border-radius:6px;">`;
  };
  reader.readAsDataURL(input.files[0]);
}

async function sendBroadcast() {
  const text = document.getElementById('broadcastText').value.trim();
  if (!text) { showToast('Введите текст сообщения', 'error'); return; }

  const btn = document.getElementById('broadcastBtn');
  const result = document.getElementById('broadcastResult');
  btn.disabled = true;
  btn.textContent = 'Отправка...';
  result.classList.add('hidden');

  const fd = new FormData();
  fd.append('text', text);
  const photoInput = document.getElementById('broadcastPhotoInput');
  if (photoInput.files[0]) fd.append('photo', photoInput.files[0]);

  try {
    const res = await fetch(`${API}/broadcast`, {
      method: 'POST',
      headers: { 'x-admin-password': state.adminPassword },
      body: fd
    });
    const data = await res.json();
    result.className = 'broadcast-result success';
    result.textContent = `✅ Отправлено: ${data.sent} из ${data.total} пользователей`;
    result.classList.remove('hidden');
    document.getElementById('broadcastText').value = '';
    photoInput.value = '';
    document.getElementById('broadcastPhotoPreview').textContent = '📷';
    document.getElementById('broadcastPhotoName').textContent = 'Прикрепить фото';
  } catch (err) {
    result.className = 'broadcast-result error';
    result.textContent = '❌ Ошибка: ' + err.message;
    result.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '📢 Отправить всем';
  }
}

// ═══════════════════════════════════════════════════════════════
// ADMIN — STATS
// ═══════════════════════════════════════════════════════════════

async function loadStats() {
  try {
    const stats = await api('GET', '/stats', null, true);
    const products = await api('GET', '/products');
    renderStats(stats, products);
  } catch {
    showToast('Ошибка загрузки статистики', 'error');
  }
}

function renderStats(stats, products) {
  const grid = document.getElementById('statsGrid');
  grid.innerHTML = `
    <div class="stat-card">
      <div class="stat-icon">👥</div>
      <div class="stat-value">${stats.totalUsers}</div>
      <div class="stat-label">Пользователей</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">📋</div>
      <div class="stat-value">${stats.totalOrders}</div>
      <div class="stat-label">Всего заказов</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">📅</div>
      <div class="stat-value">${stats.todayOrders}</div>
      <div class="stat-label">Заказов сегодня</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">💰</div>
      <div class="stat-value">${stats.todaySales}</div>
      <div class="stat-label">Продаж сегодня (сом)</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">📦</div>
      <div class="stat-value">${stats.availableProducts}/${stats.totalProducts}</div>
      <div class="stat-label">Товаров в наличии</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">🏆</div>
      <div class="stat-value" style="font-size:14px">${stats.topProduct?.name || '—'}</div>
      <div class="stat-label">Топ вкус (${stats.topProduct?.sales || 0} шт.)</div>
    </div>
  `;

  // Top products list
  const topList = document.getElementById('statsTopProducts');
  const sorted = [...products].sort((a, b) => (b.sales || 0) - (a.sales || 0)).slice(0, 5);
  topList.innerHTML = sorted.map((p, i) => `
    <div class="top-product-row">
      <span class="top-product-rank">${['🥇','🥈','🥉','4️⃣','5️⃣'][i]}</span>
      <span class="top-product-name">${p.name}</span>
      <span class="top-product-sales">${p.sales || 0} шт.</span>
    </div>
  `).join('');
}

// ═══════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
