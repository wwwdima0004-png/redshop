/* ═══════════════════════════════════════════════════════════════
   Red Shop — Telegram Mini App
   ═══════════════════════════════════════════════════════════════ */

// ─── Telegram WebApp init ────────────────────────────────────────────────────
const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
  tg.setHeaderColor('#0a0a0a');
  tg.setBackgroundColor('#0a0a0a');
}

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  products: [],
  cart: [],        // [{id, name, price, photo, qty}]
  discount: 0,
  adminPassword: null,
  currentAdminTab: 'products',
  currentChatUserId: null,
  ordersFilter: 'all',
  wheelRotation: 0,
  spinning: false
};

// ─── API ─────────────────────────────────────────────────────────────────────
const API = '/api';

async function api(method, endpoint, body, adminRequired = false) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (adminRequired && state.adminPassword) {
    opts.headers['x-admin-password'] = state.adminPassword;
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
  await loadProducts();
  checkSpinStatus();
  checkExistingDiscount();
});

// ═══════════════════════════════════════════════════════════════
// SHOP
// ═══════════════════════════════════════════════════════════════

async function loadProducts() {
  try {
    state.products = await api('GET', '/products');
    renderCatalog();
  } catch (err) {
    showToast('Не удалось загрузить товары', 'error');
  }
}

function renderCatalog() {
  const grid = document.getElementById('catalog');
  const empty = document.getElementById('catalogEmpty');
  const count = document.getElementById('catalogCount');
  const available = state.products.filter(p => p.available);

  grid.innerHTML = '';
  count.textContent = `${available.length} вкусов`;

  if (state.products.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  state.products.forEach(product => {
    const card = document.createElement('div');
    card.className = `product-card${!product.available ? ' out-of-stock' : ''}`;
    const inCart = state.cart.some(c => c.id === product.id);

    card.innerHTML = `
      <div class="product-photo-wrap" onclick="previewImage('${product.photo}')">
        <img class="product-photo" src="${product.photo}" alt="${product.name}"
          onerror="this.src='/img/placeholder.svg'">
        ${!product.available ? '<div class="out-of-stock-overlay">Нет в наличии</div>' : ''}
        <div class="product-badge">ВЕЙП</div>
      </div>
      <div class="product-info">
        <div class="product-name">${product.name}</div>
        <div class="product-desc">${product.description || ''}</div>
        <div class="product-price">${product.price} сом</div>
      </div>
      <button class="btn-add-cart ${inCart ? 'in-cart' : ''}"
        ${!product.available ? 'disabled' : ''}
        onclick="toggleCart(${product.id})" id="cartBtn_${product.id}">
        ${inCart ? '✓ В корзине' : '+ В корзину'}
      </button>
    `;
    grid.appendChild(card);
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

  // Re-render catalog buttons
  state.products.forEach(p => {
    const btn = document.getElementById(`cartBtn_${p.id}`);
    if (!btn) return;
    const inCart = state.cart.some(c => c.id === p.id);
    btn.textContent = inCart ? '✓ В корзине' : '+ В корзину';
    btn.className = `btn-add-cart ${inCart ? 'in-cart' : ''}`;
  });
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

  // If Telegram Web App is available, use sendData
  if (tg && tg.sendData) {
    try {
      tg.sendData(JSON.stringify(orderData));
      state.cart = [];
      state.discount = 0;
      localStorage.removeItem('redshop_discount');
      updateCartUI();
      closeModal('cartModal');
      showToast('Заказ отправлен! ✓', 'success');
    } catch {
      // Fallback to API
      await submitOrderViaAPI(orderData);
    }
  } else {
    // Dev mode — use API directly
    await submitOrderViaAPI(orderData);
  }
}

async function submitOrderViaAPI(orderData) {
  try {
    const order = await api('POST', '/orders', orderData);
    state.cart = [];
    state.discount = 0;
    localStorage.removeItem('redshop_discount');
    updateCartUI();
    closeModal('cartModal');
    showToast(`Заказ #${order.id} принят! ✓`, 'success');
  } catch (err) {
    showToast('Ошибка при оформлении заказа', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// ROULETTE
// ═══════════════════════════════════════════════════════════════

const SEGMENTS = [
  { label: '50 сом',  discount: 50,  degrees: 270, color: '#e31e24', textColor: '#fff' },
  { label: '100 сом', discount: 100, degrees: 54,  color: '#8b0000', textColor: '#fff' },
  { label: '150 сом', discount: 150, degrees: 36,  color: '#ff6b6b', textColor: '#fff' }
];

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

function drawWheel(rotation) {
  const canvas = document.getElementById('wheelCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = Math.min(cx, cy) - 8;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);

  let startAngle = -Math.PI / 2; // Start from top (12 o'clock)

  SEGMENTS.forEach((seg, i) => {
    const segAngle = (seg.degrees / 360) * 2 * Math.PI;

    // Sector
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, startAngle, startAngle + segAngle);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();

    // Sector border
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label
    const midAngle = startAngle + segAngle / 2;
    const lx = Math.cos(midAngle) * radius * 0.62;
    const ly = Math.sin(midAngle) * radius * 0.62;

    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(midAngle + Math.PI / 2);
    ctx.fillStyle = seg.textColor;
    ctx.font = `bold ${seg.degrees > 100 ? 16 : 13}px Inter, Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(seg.label, 0, 0);
    ctx.restore();

    startAngle += segAngle;
  });

  // Outer ring
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(227,30,36,0.5)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Center circle
  ctx.beginPath();
  ctx.arc(0, 0, 22, 0, 2 * Math.PI);
  ctx.fillStyle = '#0a0a0a';
  ctx.fill();
  ctx.strokeStyle = '#e31e24';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(0, 0, 6, 0, 2 * Math.PI);
  ctx.fillStyle = '#e31e24';
  ctx.fill();

  ctx.restore();
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
  document.getElementById('spinBtn').disabled = true;
  document.getElementById('spinResultBox')?.classList.add('hidden');

  // Determine result with weighted probability
  const rand = Math.random() * 100;
  let resultIdx;
  if (rand < 75) resultIdx = 0;      // 50 сом (75%)
  else if (rand < 90) resultIdx = 1; // 100 сом (15%)
  else resultIdx = 2;                 // 150 сом (10%)

  const seg = SEGMENTS[resultIdx];

  // Calculate cumulative start angles (in degrees from top)
  const cumulative = [];
  let cum = 0;
  SEGMENTS.forEach((s, i) => {
    cumulative.push(cum);
    cum += s.degrees;
  });

  // To show segment i at top, we rotate the wheel so that a random point
  // within that segment appears under the pointer.
  const segStart = cumulative[resultIdx];
  const segEnd = segStart + seg.degrees;
  // Pick random point within segment (avoid edges for clarity)
  const targetDeg = segStart + seg.degrees * (0.2 + Math.random() * 0.6);

  // The wheel rotation needed: to bring `targetDeg` to top (0),
  // rotate clockwise by (360 - targetDeg), which in canvas terms is:
  // rotate by -(targetDeg) radians (canvas rotates CCW for negative)
  const extraSpins = 5 + Math.floor(Math.random() * 3);
  const finalDeg = -(extraSpins * 360 + targetDeg);
  const finalRad = finalDeg * Math.PI / 180;

  const startRot = state.wheelRotation;
  const startTime = performance.now();
  const duration = 4500;

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 4);
  }

  function animate(now) {
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);
    const eased = easeOut(t);

    state.wheelRotation = startRot + (finalRad - startRot) * eased;
    drawWheel(state.wheelRotation);

    if (t < 1) {
      requestAnimationFrame(animate);
    } else {
      // Done
      state.spinning = false;
      state.wheelRotation = finalRad % (2 * Math.PI);

      localStorage.setItem('redshop_lastSpin', today);
      localStorage.setItem('redshop_discount', seg.discount);

      // Show result
      const resultBox = document.getElementById('spinResultBox');
      const resultText = document.getElementById('spinResultText');
      const resultIcon = document.getElementById('spinResultIcon');
      if (resultBox) {
        resultIcon.textContent = seg.discount === 150 ? '🤩' : seg.discount === 100 ? '🎊' : '🎉';
        resultText.textContent = `Вы выиграли скидку ${seg.label}!`;
        resultBox.classList.remove('hidden');
      }

      // Apply discount
      applyDiscount(seg.discount, true);

      // Show cooldown
      document.getElementById('spinBtn').classList.add('hidden');
      document.getElementById('spinCooldown').classList.remove('hidden');

      showToast(`🎉 Скидка ${seg.label} применена!`, 'success');
    }
  }

  requestAnimationFrame(animate);
}

function applyDiscount(amount, notify = false) {
  state.discount = amount;
  const banner = document.getElementById('discountBanner');
  const amountEl = document.getElementById('discountBannerAmount');
  if (banner && amountEl) {
    amountEl.textContent = amount;
    banner.classList.remove('hidden');
  }
  updateCartUI();
  if (notify) closeModal('rouletteModal');
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
// ADMIN AUTH
// ═══════════════════════════════════════════════════════════════

function openAdminLogin() {
  document.getElementById('adminPasswordInput').value = '';
  document.getElementById('adminLoginError').classList.add('hidden');
  openModal('adminLoginModal');
  setTimeout(() => document.getElementById('adminPasswordInput').focus(), 300);
}

async function loginAdmin() {
  const pass = document.getElementById('adminPasswordInput').value.trim();
  if (!pass) return;

  try {
    await api('POST', '/auth', { password: pass });
    state.adminPassword = pass;
    closeModal('adminLoginModal');
    showAdminPanel();
  } catch {
    document.getElementById('adminLoginError').classList.remove('hidden');
  }
}

function showAdminPanel() {
  document.getElementById('shopView').classList.add('hidden');
  document.getElementById('adminPanel').classList.remove('hidden');
  switchAdminTab('products');
}

function logoutAdmin() {
  state.adminPassword = null;
  document.getElementById('adminPanel').classList.add('hidden');
  document.getElementById('shopView').classList.remove('hidden');
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
// ADMIN — PRODUCTS
// ═══════════════════════════════════════════════════════════════

async function loadAdminProducts() {
  try {
    state.products = await api('GET', '/products');
    renderAdminProducts();
  } catch (err) {
    showToast('Ошибка загрузки товаров', 'error');
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
          <span class="admin-product-price">${product.price} сом</span>
          <span class="admin-product-sales">Продано: ${product.sales || 0}</span>
          <span class="status-pill ${product.available ? 'available' : 'unavailable'}">
            ${product.available ? 'В наличии' : 'Нет в наличии'}
          </span>
        </div>
        <div id="editRow_${product.id}" class="inline-edit-row hidden">
          <input type="number" class="form-input" id="priceInput_${product.id}"
            value="${product.price}" placeholder="Цена" min="1">
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
  const price = parseInt(input.value);
  if (!price || price < 1) { showToast('Введите корректную цену', 'error'); return; }

  try {
    const fd = new FormData();
    fd.append('price', price);
    await fetch(`${API}/products/${id}`, {
      method: 'PUT',
      headers: { 'x-admin-password': state.adminPassword },
      body: fd
    });
    showToast('Цена обновлена ✓', 'success');
    await loadAdminProducts();
  } catch {
    showToast('Ошибка обновления', 'error');
  }
}

// Hidden file input for photo change
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
    await fetch(`${API}/products/${photoChangeProductId}`, {
      method: 'PUT',
      headers: { 'x-admin-password': state.adminPassword },
      body: fd
    });
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

async function toggleAvailability(id) {
  const product = state.products.find(p => p.id === id);
  if (!product) return;
  try {
    const fd = new FormData();
    fd.append('available', !product.available);
    await fetch(`${API}/products/${id}`, {
      method: 'PUT',
      headers: { 'x-admin-password': state.adminPassword },
      body: fd
    });
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
  const fd = new FormData(form);

  // Use the hidden file input's file
  const fileInput = document.getElementById('addProductPhoto');
  if (fileInput.files[0]) fd.set('photo', fileInput.files[0]);

  try {
    await fetch(`${API}/products`, {
      method: 'POST',
      headers: { 'x-admin-password': state.adminPassword },
      body: fd
    });
    showToast('Товар добавлен ✓', 'success');
    form.reset();
    document.getElementById('addProductPhotoPreview').textContent = '📷';
    document.getElementById('addProductPhotoName').textContent = 'Выберите фото';
    await loadAdminProducts();
  } catch (err) {
    showToast('Ошибка добавления: ' + err.message, 'error');
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
    const itemsText = (order.items || []).map(i => `${i.name} ×${i.qty}`).join(', ');

    card.innerHTML = `
      <div class="order-header">
        <span class="order-id">#${order.id}</span>
        <span class="order-date">${date}</span>
      </div>
      <div class="order-customer">
        👤 ${order.userName || 'Аноним'}
        ${order.username ? `<span style="color:var(--grey);font-weight:400"> @${order.username}</span>` : ''}
      </div>
      <div class="order-items">📦 ${itemsText}</div>
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
