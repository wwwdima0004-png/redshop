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
  models: [],
  adminModelsFilterBrandId: '',
  adminProductsFilterBrandId: '',
  adminProductsFilterModelId: '',
  adminProductsFilterFlavor: '',
  selectedCategoryId: null,
  catalogSearchQuery: '',
  cart: [],        // [{id, name, price, photo, qty}]
  adminPassword: null,       // legacy (kept for backward compat)
  telegramInitData: null,    // Telegram initData string (cryptographic)
  adminUserId: null,         // verified admin Telegram user ID
  isAdmin: false,
  currentAdminTab: 'products',
  currentChatUserId: null,
  ordersFilter: 'all',
  wheelRotation: 0,
  spinning: false,
  rouletteRemainingMs: 0,
  rouletteTimerInterval: null,
  buyProductId: null,
  currentMainTab: 'catalog',
  myOrdersCount: null,
  userBalance: 0,
  cartUseBalance: false,
  buyUseBalance: false,
  referralCount: 0,
  referralLink: '',
  referralBonus: 30,
  promoDiscount: 0,
  pendingFreeOrder: false,
  currentAppearance: 'light',
  currentAccent: 'scarlet',
  banner: null,
  flavorModalModelId: null,
  modelModalBrandId: null,
  selectedFlavorId: null
};

const DEFAULT_BANNER = {
  tag: 'НИЗКИЕ ЦЕНЫ, УЖЕ СЕГОДНЯ',
  title: 'График с 13:00 до 00:00',
  subtitle: 'Поступление уже в боте!!!',
  buttonText: 'Крутить колесо'
};

const APPEARANCE_MODES = {
  dark: { name: 'Тёмная', desc: 'Чёрный фон и белый текст' },
  light: { name: 'Светлая', desc: 'Светлый фон и тёмный текст' }
};

const ACCENT_COLORS = {
  scarlet: { name: 'Алый', desc: 'Фирменный Red Shop', preview: '#e31e24' },
  sapphire: { name: 'Сапфир', desc: 'Благородный синий', preview: '#1d4ed8' },
  amethyst: { name: 'Аметист', desc: 'Глубокий фиолетовый', preview: '#7c3aed' },
  platinum: { name: 'Платина', desc: 'Строгий минимализм', preview: '#64748b' }
};

const ACCENT_ALIASES = {
  red: 'scarlet',
  scarlet: 'scarlet',
  blue: 'sapphire',
  sapphire: 'sapphire',
  purple: 'amethyst',
  amethyst: 'amethyst',
  pink: 'amethyst',
  platinum: 'platinum',
  grey: 'platinum',
  gray: 'platinum',
  gold: 'scarlet',
  green: 'scarlet'
};

function normalizeAccentId(accent) {
  if (ACCENT_COLORS[accent]) return accent;
  return ACCENT_ALIASES[accent] || 'scarlet';
}

const APPEARANCE_STORAGE_KEY = 'redshop_appearance';
const ACCENT_STORAGE_KEY = 'redshop_accent';
const LEGACY_THEME_KEY = 'redshop_theme';
const LAST_WIN_KEY = 'redshop_last_win';

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
let cartSyncTimer = null;
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
  initTheme();
  initAgeGate();
  switchMainTab('catalog');
  handleDeepLinkOpen();
  await Promise.all([initShop(), loadBanner()]);
  refreshUserBalance();
  renderProfile();
  initAdminCheck();
});

function handleDeepLinkOpen() {
  const open = new URLSearchParams(window.location.search).get('open');
  if (open === 'cart') {
    switchMainTab('catalog');
    setTimeout(() => openCart(), 400);
  } else if (open === 'bonus') {
    switchMainTab('bonus');
  }
}

async function syncCartToServer() {
  const initData = getTelegramInitData();
  if (!initData) return;
  try {
    await fetch(`${API}/cart/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-init-data': initData
      },
      body: JSON.stringify({
        items: state.cart.map(c => ({
          id: c.id,
          name: c.name,
          price: c.price,
          qty: c.qty
        }))
      })
    });
  } catch {}
}

function scheduleCartSync() {
  clearTimeout(cartSyncTimer);
  cartSyncTimer = setTimeout(syncCartToServer, 400);
}

function loadThemeSettings() {
  let appearance = 'light';
  let accent = 'scarlet';
  try {
    appearance = localStorage.getItem(APPEARANCE_STORAGE_KEY) || 'light';
    accent = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (!accent) {
      const legacy = localStorage.getItem(LEGACY_THEME_KEY);
      accent = legacy || 'scarlet';
    }
    accent = normalizeAccentId(accent);
    if (!APPEARANCE_MODES[appearance]) appearance = 'light';
  } catch {}
  return { appearance, accent };
}

function initTheme() {
  const { appearance, accent } = loadThemeSettings();
  applyThemeSettings(appearance, accent, false);
}

function applyThemeSettings(appearance, accent, save = true) {
  if (!APPEARANCE_MODES[appearance]) appearance = 'light';
  accent = normalizeAccentId(accent);
  state.currentAppearance = appearance;
  state.currentAccent = accent;
  document.documentElement.setAttribute('data-accent', accent);
  document.body.setAttribute('data-appearance', appearance);
  document.body.removeAttribute('data-theme');
  if (save) {
    try {
      localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
      localStorage.setItem(ACCENT_STORAGE_KEY, accent);
    } catch {}
  }
  if (tg?.setHeaderColor) {
    const c = appearance === 'light' ? '#fff8f8' : '#0a0a0a';
    try { tg.setHeaderColor(c); tg.setBackgroundColor(c); } catch {}
  }
  renderThemeOptions();
  if (document.getElementById('wheelCanvas')) {
    requestAnimationFrame(() => drawWheel(state.wheelRotation));
  }
}

function renderThemeOptions() {
  const appearanceGrid = document.getElementById('appearanceGrid');
  const accentsGrid = document.getElementById('accentsGrid');
  if (!appearanceGrid || !accentsGrid) return;

  appearanceGrid.innerHTML = Object.entries(APPEARANCE_MODES).map(([id, mode]) => {
    const active = state.currentAppearance === id;
    return `
      <button type="button" class="appearance-card${active ? ' active' : ''}" onclick="selectAppearance('${id}')">
        <span class="appearance-preview appearance-preview-${id}" aria-hidden="true"></span>
        <span class="appearance-card-name">${mode.name}</span>
        <span class="appearance-card-desc">${mode.desc}</span>
        <span class="appearance-card-check">${active ? '✓ Выбрано' : ''}</span>
      </button>
    `;
  }).join('');

  accentsGrid.innerHTML = Object.entries(ACCENT_COLORS).map(([id, accent]) => {
    const active = state.currentAccent === id;
    return `
      <button type="button" class="accent-card${active ? ' active' : ''}" onclick="selectAccent('${id}')">
        <span class="accent-preview" style="background:${accent.preview}" aria-hidden="true"></span>
        <span class="accent-card-info">
          <span class="accent-card-name">${accent.name}</span>
          <span class="accent-card-desc">${accent.desc}</span>
        </span>
        <span class="accent-card-check">${active ? '✓' : ''}</span>
      </button>
    `;
  }).join('');
}

function selectAppearance(appearanceId) {
  applyThemeSettings(appearanceId, state.currentAccent, true);
  showToast(`Тема «${APPEARANCE_MODES[appearanceId]?.name || appearanceId}» применена`, 'success');
}

function selectAccent(accentId) {
  applyThemeSettings(state.currentAppearance, accentId, true);
  showToast(`Акцент «${ACCENT_COLORS[accentId]?.name || accentId}» применён`, 'success');
}

function openThemesScreen() {
  openProfileSubscreen('themesScreen');
  renderThemeOptions();
}

function closeThemesScreen() {
  closeProfileSubscreens(true);
}

function initAgeGate() {
  const modal = document.getElementById('ageGateModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const cb = document.getElementById('ageGateAccept');
  const btn = document.getElementById('ageGateOkBtn');
  if (cb) cb.checked = false;
  if (btn) btn.disabled = true;
}

function onAgeGateAcceptChange() {
  const cb = document.getElementById('ageGateAccept');
  const btn = document.getElementById('ageGateOkBtn');
  if (btn) btn.disabled = !cb?.checked;
}

function confirmAgeGate() {
  const accepted = document.getElementById('ageGateAccept')?.checked;
  if (!accepted) return;
  document.getElementById('ageGateModal')?.classList.add('hidden');
}

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

function switchMainTab(tab, options = {}) {
  if (!MAIN_TAB_VIEWS[tab]) return;
  state.currentMainTab = tab;

  Object.entries(MAIN_TAB_VIEWS).forEach(([key, viewId]) => {
    document.getElementById(viewId)?.classList.toggle('hidden', key !== tab);
  });

  document.querySelectorAll('.bottom-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  if (tab === 'profile') {
    if (options.resetProfileSub !== false) closeProfileSubscreens(true);
    renderProfile();
  } else if (tab === 'bonus') {
    closeProfileSubscreens(false);
    initBonusWheel();
  } else {
    closeProfileSubscreens(false);
  }
}

function showProfileMain() {
  document.getElementById('profileMain')?.classList.remove('hidden');
}

function hideAllProfileSubscreens() {
  ['orderHistoryScreen', 'referralScreen', 'promoScreen', 'themesScreen'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
}

function closeProfileSubscreens(showMain = true) {
  hideAllProfileSubscreens();
  if (showMain) showProfileMain();
}

function openProfileSubscreen(screenId) {
  switchMainTab('profile', { resetProfileSub: false });
  hideAllProfileSubscreens();
  document.getElementById('profileMain')?.classList.add('hidden');
  document.getElementById(screenId)?.classList.remove('hidden');
}

function getTelegramInitData() {
  return tg?.initData || state.telegramInitData || null;
}

const ORDER_STATUS_LABELS = {
  new: 'Новый',
  done: 'Выполнено',
  defect: 'Брак',
  cancel: 'Отмена'
};

function normalizeOrderStatus(status) {
  if (status === 'processing') return 'new';
  if (ORDER_STATUS_LABELS[status]) return status;
  return 'new';
}

function getTelegramUser() {
  return tg?.initDataUnsafe?.user || null;
}

function onProfileAvatarError() {
  const img = document.getElementById('profileAvatar');
  const placeholder = document.getElementById('profileAvatarPlaceholder');
  if (img) {
    img.classList.add('hidden');
    img.removeAttribute('src');
  }
  placeholder?.classList.remove('hidden');
}

function renderProfile() {
  const user = getTelegramUser();
  const nameEl = document.getElementById('profileName');
  const idEl = document.getElementById('profileId');
  const avatarEl = document.getElementById('profileAvatar');
  const placeholderEl = document.getElementById('profileAvatarPlaceholder');

  if (user) {
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Пользователь';
    if (nameEl) nameEl.textContent = fullName;
    if (idEl) idEl.textContent = `ID: ${user.id}`;

    if (user.photo_url && avatarEl && placeholderEl) {
      avatarEl.src = user.photo_url;
      avatarEl.alt = fullName;
      avatarEl.classList.remove('hidden');
      placeholderEl.classList.add('hidden');
    } else {
      onProfileAvatarError();
    }
  } else {
    if (nameEl) nameEl.textContent = 'Гость';
    if (idEl) idEl.textContent = 'ID: —';
    onProfileAvatarError();
  }

  const balanceEl = document.getElementById('profileBalance');
  if (balanceEl) balanceEl.textContent = String(state.userBalance ?? 0);

  if (getTelegramUser()) {
    refreshMyOrdersCount();
    refreshUserBalance();
    refreshReferralStats();
  }

  const ordersEl = document.getElementById('profileOrdersCount');
  if (ordersEl) {
    ordersEl.textContent = state.myOrdersCount != null ? String(state.myOrdersCount) : '0';
  }

  const referralsEl = document.getElementById('profileReferralsCount');
  if (referralsEl) referralsEl.textContent = String(state.referralCount ?? 0);

  updateProfileDiscountCard();
}

function updateProfileDiscountCard() {
  const card = document.getElementById('profileDiscountCard');
  const amountEl = document.getElementById('profileDiscountAmount');
  const titleEl = document.getElementById('profileDiscountTitle');
  const noteEl = document.getElementById('profileDiscountNote');
  if (!card) return;

  if (state.pendingFreeOrder) {
    card.classList.remove('hidden');
    if (titleEl) titleEl.textContent = 'Бесплатный заказ';
    if (noteEl) noteEl.textContent = 'При следующем оформлении';
    if (amountEl) amountEl.textContent = '🎁';
  } else if (state.promoDiscount > 0) {
    card.classList.remove('hidden');
    if (titleEl) titleEl.textContent = 'Скидка на заказ';
    if (noteEl) noteEl.textContent = 'При оформлении заказа';
    if (amountEl) amountEl.textContent = `${state.promoDiscount} сом`;
  } else {
    card.classList.add('hidden');
  }
}

function profileMenuStub(section) {
  showToast('Раздел — скоро будет доступно');
}

function updateReferralBonusDisplay(bonus) {
  const amount = Math.max(0, Math.round(Number(bonus) || 0));
  state.referralBonus = amount;
  const el = document.getElementById('referralBonusAmount');
  if (el) el.textContent = `+${amount} сом`;
}

async function fetchReferralsMy() {
  const initData = getTelegramInitData();
  if (!initData) throw new Error('Откройте приложение через Telegram');
  const res = await fetch(`${API}/referrals/my`, {
    headers: { 'x-telegram-init-data': initData }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Не удалось загрузить рефералы');
  return data;
}

async function refreshReferralStats() {
  try {
    const data = await fetchReferralsMy();
    state.referralCount = data.count ?? 0;
    state.referralLink = data.link || '';
    if (data.bonus != null) updateReferralBonusDisplay(data.bonus);
    const el = document.getElementById('profileReferralsCount');
    if (el) el.textContent = String(state.referralCount);
  } catch {}
}

async function openReferralProgram() {
  openProfileSubscreen('referralScreen');
  try {
    const data = await fetchReferralsMy();
    state.referralCount = data.count ?? 0;
    state.referralLink = data.link || '';
    if (data.bonus != null) updateReferralBonusDisplay(data.bonus);
    document.getElementById('referralScreenCount').textContent = String(state.referralCount);
    document.getElementById('referralLinkInput').value = data.link || '';
    document.getElementById('profileReferralsCount').textContent = String(state.referralCount);
  } catch (err) {
    closeProfileSubscreens(true);
    showToast(err.message || 'Ошибка загрузки', 'error');
  }
}

function closeReferralScreen() {
  closeProfileSubscreens(true);
}

function copyReferralLink() {
  const link = document.getElementById('referralLinkInput')?.value || state.referralLink;
  if (!link) return showToast('Ссылка недоступна', 'error');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(link).then(() => showToast('Ссылка скопирована ✓', 'success'));
  } else {
    const input = document.getElementById('referralLinkInput');
    input?.select();
    document.execCommand('copy');
    showToast('Ссылка скопирована ✓', 'success');
  }
}

function shareReferralLink() {
  const link = document.getElementById('referralLinkInput')?.value || state.referralLink;
  if (!link) return showToast('Ссылка недоступна', 'error');
  const bonus = state.referralBonus || 30;
  const text = `Присоединяйся к Red Shop! Получи +${bonus} сом на баланс: ${link}`;
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`Присоединяйся к Red Shop! +${bonus} сом на баланс`)}`);
  } else if (navigator.share) {
    navigator.share({ title: 'Red Shop', text, url: link }).catch(() => copyReferralLink());
  } else {
    copyReferralLink();
  }
}

function openPromoScreen() {
  openProfileSubscreen('promoScreen');
  document.getElementById('promoCodeInput').value = '';
  document.getElementById('promoResult')?.classList.add('hidden');
  updatePromoPendingInfo();
}

function closePromoScreen() {
  closeProfileSubscreens(true);
}

function updatePromoPendingInfo() {
  const el = document.getElementById('promoPendingInfo');
  if (!el) return;
  const parts = [];
  if (state.pendingFreeOrder) parts.push('🎁 Бесплатный заказ ожидает применения');
  if (state.promoDiscount > 0) parts.push(`🏷️ Промо-скидка: ${state.promoDiscount} сом на следующий заказ`);
  if (parts.length) {
    el.textContent = parts.join(' · ');
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

async function activatePromoCode() {
  const input = document.getElementById('promoCodeInput');
  const code = input?.value.trim();
  if (!code) return showToast('Введите промокод', 'error');

  const btn = document.getElementById('promoActivateBtn');
  const resultEl = document.getElementById('promoResult');
  if (btn) { btn.disabled = true; btn.textContent = 'Проверка...'; }

  try {
    const initData = getTelegramInitData();
    if (!initData) throw new Error('Откройте приложение через Telegram');
    const res = await fetch(`${API}/promo/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-telegram-init-data': initData
      },
      body: JSON.stringify({ code })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка активации');

    if (typeof data.newBalance === 'number') state.userBalance = data.newBalance;
    state.promoDiscount = data.pendingPromoDiscount || 0;
    state.pendingFreeOrder = !!data.pendingFreeOrder;

    document.getElementById('profileBalance').textContent = String(state.userBalance);
    if (resultEl) {
      resultEl.textContent = data.message || 'Промокод активирован!';
      resultEl.className = 'promo-result promo-result-success';
      resultEl.classList.remove('hidden');
    }
    updatePromoPendingInfo();
    if (input) input.value = '';
    showToast(data.message || 'Промокод активирован ✓', 'success');
  } catch (err) {
    if (resultEl) {
      resultEl.textContent = err.message || 'Ошибка';
      resultEl.className = 'promo-result promo-result-error';
      resultEl.classList.remove('hidden');
    }
    showToast(err.message || 'Ошибка активации', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Активировать'; }
  }
}

async function fetchMyOrders() {
  const initData = getTelegramInitData();
  if (!initData) {
    throw new Error('Откройте приложение через Telegram');
  }
  const res = await fetch(`${API}/orders/my`, {
    headers: { 'x-telegram-init-data': initData }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Не удалось загрузить заказы');
  return data;
}

async function refreshMyOrdersCount() {
  try {
    const orders = await fetchMyOrders();
    state.myOrdersCount = orders.length;
    const ordersEl = document.getElementById('profileOrdersCount');
    if (ordersEl) ordersEl.textContent = String(state.myOrdersCount);
  } catch {}
}

async function fetchMeUser() {
  const initData = getTelegramInitData();
  if (!initData) return null;
  const res = await fetch(`${API}/users/me`, {
    headers: { 'x-telegram-init-data': initData }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Не удалось загрузить профиль');
  return data;
}

async function refreshUserBalance() {
  try {
    const me = await fetchMeUser();
    if (!me) return;
    if (typeof me.balance === 'number') state.userBalance = me.balance;
    state.promoDiscount = me.pendingPromoDiscount || 0;
    state.pendingFreeOrder = !!me.pendingFreeOrder;
    if (typeof me.referralCount === 'number') state.referralCount = me.referralCount;
    const balanceEl = document.getElementById('profileBalance');
    if (balanceEl) balanceEl.textContent = String(state.userBalance);
    const refEl = document.getElementById('profileReferralsCount');
    if (refEl) refEl.textContent = String(state.referralCount);
    updateProfileDiscountCard();
  } catch {}
}

function calcOrderPayment(subtotal, useBalance = false) {
  if (state.pendingFreeOrder) {
    return {
      subtotal,
      discount: subtotal,
      promoDiscount: state.promoDiscount || 0,
      afterDiscount: 0,
      balanceUsed: 0,
      finalTotal: 0,
      freeOrder: true
    };
  }
  const promo = Math.min(state.promoDiscount || 0, subtotal);
  const afterDiscount = Math.max(0, subtotal - promo);
  const balanceUsed = useBalance && state.userBalance > 0
    ? Math.min(state.userBalance, afterDiscount)
    : 0;
  const finalTotal = Math.max(0, afterDiscount - balanceUsed);
  return { subtotal, discount: promo, promoDiscount: promo, afterDiscount, balanceUsed, finalTotal, freeOrder: false };
}

function onBalanceToggleChange(context) {
  if (context === 'cart') {
    state.cartUseBalance = document.getElementById('cartUseBalance')?.checked || false;
    renderCartItems();
  } else if (context === 'buy') {
    state.buyUseBalance = document.getElementById('buyUseBalance')?.checked || false;
    updateBuyOrderTotals();
  }
}

function updateBalanceToggleUI(context, subtotal) {
  const payment = calcOrderPayment(subtotal, false);
  const canUse = state.userBalance > 0 && payment.afterDiscount > 0 && getTelegramInitData() && !state.pendingFreeOrder;

  if (context === 'cart') {
    const wrap = document.getElementById('cartBalanceToggleWrap');
    const avail = document.getElementById('cartBalanceAvailable');
    if (wrap) wrap.classList.toggle('hidden', !canUse);
    if (avail) avail.textContent = String(state.userBalance);
    if (!canUse) {
      state.cartUseBalance = false;
      const cb = document.getElementById('cartUseBalance');
      if (cb) cb.checked = false;
    }
  } else if (context === 'buy') {
    const wrap = document.getElementById('buyBalanceToggleWrap');
    const avail = document.getElementById('buyBalanceAvailable');
    if (wrap) wrap.classList.toggle('hidden', !canUse);
    if (avail) avail.textContent = String(state.userBalance);
    if (!canUse) {
      state.buyUseBalance = false;
      const cb = document.getElementById('buyUseBalance');
      if (cb) cb.checked = false;
    }
  }
}

function updateBuyOrderTotals() {
  const product = state.products.find(p => p.id === state.buyProductId);
  if (!product) return;
  const subtotal = getProductModelPrice(product);
  const payment = calcOrderPayment(subtotal, state.buyUseBalance);
  const totalsEl = document.getElementById('buyOrderTotals');
  if (!totalsEl) return;

  totalsEl.innerHTML = `
    <div class="buy-total-row"><span>Сумма:</span><span>${payment.subtotal} сом</span></div>
    ${payment.freeOrder ? `<div class="buy-total-row discount"><span>🎁 Бесплатный заказ</span><span>−${payment.subtotal} сом</span></div>` : ''}
    ${!payment.freeOrder && payment.promoDiscount > 0 ? `<div class="buy-total-row discount"><span>🏷️ Промо-скидка:</span><span>−${payment.promoDiscount} сом</span></div>` : ''}
    ${payment.balanceUsed > 0 ? `<div class="buy-total-row discount"><span>💳 С баланса:</span><span>−${payment.balanceUsed} сом</span></div>` : ''}
    <div class="buy-total-row final"><span>Итого:</span><span>${payment.finalTotal} сом</span></div>
  `;
}

function formatOrderDate(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function renderMyOrders(orders) {
  const list = document.getElementById('myOrdersList');
  const empty = document.getElementById('myOrdersEmpty');
  if (!list || !empty) return;

  list.innerHTML = '';

  if (!orders.length) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');

  orders.forEach(order => {
    const card = document.createElement('div');
    card.className = `my-order-card status-${normalizeOrderStatus(order.status)}`;
    const statusLabel = ORDER_STATUS_LABELS[normalizeOrderStatus(order.status)] || order.status || '—';
    const itemsHtml = (order.items || [])
      .map(i => `<li>${escapeHtml(i.name)} ×${i.qty || 1}</li>`)
      .join('');

    card.innerHTML = `
      <div class="my-order-card-top">
        <span class="my-order-date">${formatOrderDate(order.createdAt)}</span>
        <span class="my-order-status">${statusLabel}</span>
      </div>
      <ul class="my-order-items">${itemsHtml || '<li>—</li>'}</ul>
      <div class="my-order-footer">
        ${order.discount ? `<span class="my-order-discount">Скидка: −${order.discount} сом</span>` : ''}
        <span class="my-order-total">${order.finalTotal ?? order.total ?? 0} сом</span>
      </div>
    `;
    list.appendChild(card);
  });
}

async function openOrderHistory() {
  openProfileSubscreen('orderHistoryScreen');

  const loading = document.getElementById('myOrdersLoading');
  const list = document.getElementById('myOrdersList');
  const empty = document.getElementById('myOrdersEmpty');

  if (loading) loading.classList.remove('hidden');
  if (list) list.innerHTML = '';
  if (empty) empty.classList.add('hidden');

  try {
    const orders = await fetchMyOrders();
    state.myOrdersCount = orders.length;
    const ordersEl = document.getElementById('profileOrdersCount');
    if (ordersEl) ordersEl.textContent = String(state.myOrdersCount);
    renderMyOrders(orders);
  } catch (err) {
    closeProfileSubscreens(true);
    showToast(err.message || 'Ошибка загрузки заказов', 'error');
  } finally {
    if (loading) loading.classList.add('hidden');
  }
}

function closeOrderHistory() {
  closeProfileSubscreens(true);
}

// ═══════════════════════════════════════════════════════════════
// SHOP
// ═══════════════════════════════════════════════════════════════

async function loadBanner() {
  try {
    const data = await api('GET', '/banner');
    state.banner = data;
  } catch {
    state.banner = { ...DEFAULT_BANNER };
  }
  renderCatalogBanner();
}

function renderCatalogBanner() {
  const b = state.banner || {};
  const tag = (b.tag || '').trim();
  const title = (b.title || '').trim();
  const subtitle = (b.subtitle || '').trim();
  const buttonText = (b.buttonText || '').trim();
  const hasBg = !!(b.bgImage && String(b.bgImage).trim());
  const hasText = !!(tag || title || subtitle || buttonText);

  const promo = document.getElementById('catalogPromo');
  const content = document.getElementById('catalogPromoContent');
  const tagWrap = document.getElementById('bannerTagWrap');
  const tagEl = document.getElementById('bannerTag');
  const titleEl = document.getElementById('bannerTitle');
  const subEl = document.getElementById('bannerSubtitle');
  const btnEl = document.getElementById('bannerBtn');
  const overlay = document.getElementById('catalogPromoOverlay');

  if (!promo) return;

  if (!hasText && !hasBg) {
    promo.classList.add('hidden');
    return;
  }
  promo.classList.remove('hidden');

  tagWrap?.classList.toggle('hidden', !tag);
  if (tagEl) tagEl.textContent = tag;

  titleEl?.classList.toggle('hidden', !title);
  if (titleEl && title) titleEl.textContent = title;

  subEl?.classList.toggle('hidden', !subtitle);
  if (subEl && subtitle) subEl.textContent = subtitle;

  btnEl?.classList.toggle('hidden', !buttonText);
  if (btnEl && buttonText) btnEl.textContent = buttonText;

  const imageOnly = hasBg && !hasText;
  promo.classList.toggle('promo-image-only', imageOnly);
  content?.classList.toggle('hidden', imageOnly);

  if (hasBg) {
    promo.classList.add('has-bg-image');
    promo.style.backgroundImage = `url(${normalizePhotoSrc(b.bgImage)})`;
    overlay?.classList.remove('hidden');
    overlay?.classList.toggle('promo-overlay-light', imageOnly);
  } else {
    promo.classList.remove('has-bg-image');
    promo.style.backgroundImage = '';
    overlay?.classList.add('hidden');
    overlay?.classList.remove('promo-overlay-light');
  }
}

function getCategoryName(categoryId) {
  const cat = state.categories.find(c => Number(c.id) === Number(categoryId));
  return cat ? cat.name : '—';
}

function getModelName(modelId) {
  const model = state.models.find(m => Number(m.id) === Number(modelId));
  return model ? model.name : '—';
}

function getModelsByBrand(brandId) {
  return state.models.filter(m => Number(m.brandId) === Number(brandId));
}

function getModelProductCount(modelId) {
  return state.products.filter(p => Number(p.modelId) === Number(modelId)).length;
}

function getCategoryProductCount(categoryId) {
  return state.products.filter(p => p.categoryId === categoryId).length;
}

function getProductStock(product) {
  return Math.max(0, Math.round(Number(product?.stock) || 0));
}

function getProductReserved(product) {
  return Math.max(0, Math.round(Number(product?.reserved) || 0));
}

function getAvailableStock(product) {
  return Math.max(0, getProductStock(product) - getProductReserved(product));
}

function isProductPurchasable(product) {
  if (!product) return false;
  if (product.available === false) return false;
  return getAvailableStock(product) > 0;
}

function getProductsByModel(modelId) {
  return state.products.filter(p => Number(p.modelId) === Number(modelId));
}

function getProductsByCategory(categoryId) {
  return state.products.filter(p => p.categoryId === categoryId);
}

const FLAVOR_EMOJI_RULES = [
  [/bubble\s*gum|bubblegum|жвачк/, '🫧'],
  [/energy|энергетик|red\s*bull|monster/, '⚡'],
  [/морожен|ice\s*cream|sundae/, '🍦'],
  [/шоколад|chocolate|cocoa/, '🍫'],
  [/кофе|coffee|latte|espresso|cappuccino/, '☕'],
  [/ванил|vanilla/, '🍦'],
  [/тропик|tropic|passion\s*fruit|маракуй|maracuja/, '🌴'],
  [/цитрус|citrus/, '🍊'],
  [/berry|berries|ягод/, '🫐'],
  [/blackber|ежевик/, '🫐'],
  [/blueber|черник/, '🫐'],
  [/raspber|малин/, '🫐'],
  [/strawber|клубник/, '🍓'],
  [/cranber|клюкв/, '🫐'],
  [/watermelon|арбуз/, '🍉'],
  [/pineapple|ананас/, '🍍'],
  [/coconut|кокос/, '🥥'],
  [/melon|дын|cantaloupe|honeydew/, '🍈'],
  [/banana|банан/, '🍌'],
  [/mango|манго/, '🥭'],
  [/peach|персик|nectarine|нектарин/, '🍑'],
  [/pear|груш/, '🍐'],
  [/apple|яблок/, '🍎'],
  [/grape|виноград/, '🍇'],
  [/cherry|вишн|черешн/, '🍒'],
  [/orange|апельсин|mandarin|мандарин|tangerine/, '🍊'],
  [/lemon|лимон/, '🍋'],
  [/lime|лайм/, '🍈'],
  [/kiwi|киви/, '🥝'],
  [/lychee|личи|litchi/, '🤍'],
  [/pomegranate|гранат/, '🔴'],
  [/cola|кола|pepsi|sprite|fanta|soda/, '🥤'],
  [/menthol|ментол/, '❄️'],
  [/\bice\b|лёд|лед|айс|frost|frozen|мороз/, '🧊'],
  [/mint|мят|spearmint|peppermint/, '🌿'],
  [/guava|гуава/, '🍈'],
  [/papaya|папай/, '🍈'],
  [/plum|слив/, '🍑'],
  [/fig|инжир/, '🍈'],
  [/passion|passiflora/, '🌴'],
  [/dragon\s*fruit|питай|dragonfruit/, '🍈'],
  [/tobacco|табак/, '🍂'],
  [/caramel|карамел/, '🍮'],
  [/honey|мёд|мед/, '🍯'],
  [/cinnamon|корица/, '🍂'],
  [/matcha|матча|green\s*tea|зелён.*чай/, '🍵']
];

function getFlavorEmoji(product) {
  const name = `${product?.name || ''} ${product?.description || ''}`.toLowerCase();
  for (const [re, emoji] of FLAVOR_EMOJI_RULES) {
    if (re.test(name)) return emoji;
  }
  return '💨';
}

function getFilteredBrands() {
  let cats = state.categories;
  const q = (state.catalogSearchQuery || '').trim().toLowerCase();

  if (state.selectedCategoryId) {
    cats = cats.filter(c => c.id === state.selectedCategoryId);
  }

  cats = cats.filter(cat => {
    const models = getModelsByBrand(cat.id);
    const hasAnyModels = models.length > 0;
    const hasLegacyProducts = getProductsByCategory(cat.id).length > 0;
    if (!hasAnyModels && !hasLegacyProducts) return false;
    if (!q) return true;
    if ((cat.name || '').toLowerCase().includes(q)) return true;
    return models.some(m => modelMatchesSearch(m, q));
  });

  return cats;
}

function modelMatchesSearch(model, q) {
  if ((model.name || '').toLowerCase().includes(q)) return true;
  if ((model.badge || '').toLowerCase().includes(q)) return true;
  return getProductsByModel(model.id).some(p => flavorMatchesSearch(p, q));
}

function flavorMatchesSearch(product, q) {
  return (product.name || '').toLowerCase().includes(q) ||
    (product.description || '').toLowerCase().includes(q);
}

function getFilteredCatalogModels() {
  let models = state.models.filter(m => getProductsByModel(m.id).length > 0);
  if (state.selectedCategoryId) {
    models = models.filter(m => Number(m.brandId) === Number(state.selectedCategoryId));
  }
  const q = (state.catalogSearchQuery || '').trim().toLowerCase();
  if (q) {
    models = models.filter(m => modelMatchesSearch(m, q));
  }
  return models;
}

function getModelRecord(modelId) {
  return state.models.find(m => Number(m.id) === Number(modelId));
}

function getProductModelPrice(product) {
  const model = getModelRecord(product?.modelId);
  if (model && Number.isFinite(model.price) && model.price >= 1) {
    return model.price;
  }
  return Number(product?.price) || 0;
}

function getModelDiscountPercent(model) {
  const price = Number(model?.price) || 0;
  const oldPrice = Number(model?.oldPrice);
  if (oldPrice && oldPrice > price) {
    return Math.round((1 - price / oldPrice) * 100);
  }
  return 0;
}

function cartItemFromProduct(product) {
  return {
    id: product.id,
    name: product.name,
    price: getProductModelPrice(product),
    photo: product.photo,
    modelId: product.modelId,
    qty: 1
  };
}

function refreshCartPrices() {
  state.cart.forEach(item => {
    const product = state.products.find(p => p.id === item.id);
    if (product) item.price = getProductModelPrice(product);
  });
}

function getModelPriceInfo(modelId) {
  const model = getModelRecord(modelId);
  if (!model || !Number.isFinite(model.price) || model.price < 1) {
    return { minPrice: null, oldPrice: null, discountPercent: 0, pricePrefix: '' };
  }
  const minPrice = model.price;
  const oldPrice = Number(model.oldPrice);
  const hasDiscount = oldPrice && oldPrice > minPrice;
  return {
    minPrice,
    oldPrice: hasDiscount ? oldPrice : null,
    discountPercent: hasDiscount ? getModelDiscountPercent(model) : 0,
    pricePrefix: ''
  };
}

function formatModelPriceHtml(info) {
  if (info.minPrice == null) return '<span class="price-current">—</span>';
  const current = `${info.pricePrefix}${info.minPrice} сом`;
  if (info.oldPrice) {
    return `<span class="price-old">${info.oldPrice} сом</span><span class="price-current">${current}</span>`;
  }
  return `<span class="price-current">${current}</span>`;
}

function getModelCardDescription(model) {
  const brandName = getCategoryName(model.brandId);
  const flavorCount = getProductsByModel(model.id).length;
  if (flavorCount > 0) {
    return `${brandName} · ${flavorCount} ${pluralFlavors(flavorCount)}`;
  }
  return brandName;
}

function getModelDisplayName(model) {
  const name = (model.name || '').trim();
  if (name && name.toLowerCase() !== 'общая') return name;
  const brandName = getCategoryName(model.brandId);
  return brandName !== '—' ? brandName : name || 'Модель';
}

function getBrandModelCount(brandId) {
  return getModelsByBrand(brandId).length;
}

function getFilteredBrandModels(brandId) {
  const models = getModelsByBrand(brandId);
  const q = (state.catalogSearchQuery || '').trim().toLowerCase();
  if (!q) return models;
  return models.filter(m => modelMatchesSearch(m, q));
}

function getModelInStock(modelId) {
  return getProductsByModel(modelId).some(isProductPurchasable);
}

function getModelPriceRange(modelId) {
  const info = getModelPriceInfo(modelId);
  if (info.minPrice == null) return null;
  return `${info.minPrice} сом`;
}

function getBrandPriceRange(categoryId) {
  const models = getModelsByBrand(categoryId);
  const prices = models
    .map(m => Number(m.price))
    .filter(p => Number.isFinite(p) && p >= 1);
  if (!prices.length) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? `${min} сом` : `от ${min} сом`;
}

function pluralModels(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'модель';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'модели';
  return 'моделей';
}

function getBrandInStockCount(categoryId) {
  return getProductsByCategory(categoryId).filter(isProductPurchasable).length;
}

function pluralFlavors(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'вкус';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'вкуса';
  return 'вкусов';
}

async function initShop(attempt = 1) {
  const catalog = document.getElementById('catalog');
  const empty = document.getElementById('catalogEmpty');

  if (attempt === 1) {
    catalog.innerHTML = `
      <div class="catalog-loading" style="grid-column:1/-1">
        <div class="catalog-loading-icon">⏳</div>
        <div>Загрузка каталога...</div>
      </div>`;
    catalog.classList.remove('hidden');
    empty.classList.add('hidden');
  }

  try {
    const [products, categories, models] = await Promise.all([
      api('GET', '/products'),
      api('GET', '/categories'),
      api('GET', '/models')
    ]);
    if (!Array.isArray(products) || !Array.isArray(categories)) {
      throw new Error('Сервер вернул неверный формат');
    }
    state.products = products;
    state.categories = categories;
    state.models = Array.isArray(models) ? models : [];
    refreshCartPrices();
    state.selectedCategoryId = null;
    state.catalogSearchQuery = '';
    const searchInput = document.getElementById('catalogSearch');
    if (searchInput) searchInput.value = '';
    showCategoriesView();
  } catch (err) {
    if (attempt < 4) {
      const delay = attempt * 5000;
      catalog.innerHTML = `
        <div class="catalog-loading" style="grid-column:1/-1">
          <div class="catalog-loading-icon">🔄</div>
          <div>Сервер запускается, подождите...</div>
          <div class="catalog-loading-hint">Попытка ${attempt + 1} через ${delay / 1000} сек</div>
        </div>`;
      setTimeout(() => initShop(attempt + 1), delay);
    } else {
      catalog.innerHTML = '';
      empty.classList.remove('hidden');
      empty.innerHTML = `
        <div class="empty-icon">⚠️</div>
        <div>Не удалось загрузить каталог</div>
        <div class="catalog-loading-hint">${err.message}</div>
        <button class="btn-outline" style="margin-top:16px" onclick="initShop()">Попробовать снова</button>`;
      showToast('Ошибка загрузки каталога', 'error');
    }
  }
}

async function loadProducts(attempt = 1) {
  try {
    const [products, categories, models] = await Promise.all([
      api('GET', '/products'),
      api('GET', '/categories'),
      api('GET', '/models')
    ]);
    state.products = products;
    state.categories = categories;
    state.models = Array.isArray(models) ? models : [];
    refreshCartPrices();
    renderCategoryChips();
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
  state.catalogSearchQuery = '';
  const searchInput = document.getElementById('catalogSearch');
  if (searchInput) searchInput.value = '';
  document.getElementById('catalog')?.classList.remove('hidden');
  document.getElementById('catalogEmpty')?.classList.add('hidden');
  renderCategoryChips();
  renderCatalog();
}

function onCatalogSearch(value) {
  state.catalogSearchQuery = value;
  renderCatalog();
  if (!document.getElementById('modelModal')?.classList.contains('hidden') && state.modelModalBrandId) {
    renderModelModalGrid(getFilteredBrandModels(state.modelModalBrandId));
  }
  if (!document.getElementById('flavorModal')?.classList.contains('hidden') && state.flavorModalModelId) {
    renderFlavorModalGrid(getFilteredModalFlavors(state.flavorModalModelId));
    updateFlavorModalActions();
  }
}

function setCatalogFilter(categoryId) {
  state.selectedCategoryId = categoryId;
  renderCategoryChips();
  renderCatalog();
}

function getFilteredCatalogProducts() {
  let list = state.products;
  if (state.selectedCategoryId) {
    list = list.filter(p => p.categoryId === state.selectedCategoryId);
  }
  const q = (state.catalogSearchQuery || '').trim().toLowerCase();
  if (q) {
    list = list.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q)
    );
  }
  return list;
}

function getProductDiscountPercent(product) {
  const model = getModelRecord(product?.modelId);
  if (model) return getModelDiscountPercent(model);
  const price = Number(product.price) || 0;
  const oldPrice = Number(product.oldPrice);
  if (oldPrice && oldPrice > price) {
    return Math.round((1 - price / oldPrice) * 100);
  }
  return 0;
}

function renderCategoryChips() {
  const wrap = document.getElementById('catalogChips');
  if (!wrap) return;
  wrap.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = `catalog-chip${!state.selectedCategoryId ? ' active' : ''}`;
  allBtn.textContent = 'Все';
  allBtn.onclick = () => setCatalogFilter(null);
  wrap.appendChild(allBtn);

  state.categories.forEach(cat => {
    if (!getModelsByBrand(cat.id).length) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `catalog-chip${state.selectedCategoryId === cat.id ? ' active' : ''}`;
    btn.textContent = cat.name;
    btn.onclick = () => setCatalogFilter(cat.id);
    wrap.appendChild(btn);
  });
}

function normalizePhotoSrc(photo) {
  if (!photo) return '/img/placeholder.svg';
  if (photo.startsWith('http')) return photo;
  return photo.startsWith('/') ? photo : '/' + photo;
}

function renderCategories() {
  renderCategoryChips();
  renderCatalog();
}

function openCategory(categoryId) {
  setCatalogFilter(categoryId);
}

function backToCategories() {
  showCategoriesView();
}

function formatProductPriceHtml(product) {
  const price = getProductModelPrice(product);
  const model = getModelRecord(product?.modelId);
  const oldPrice = model?.oldPrice != null ? Number(model.oldPrice) : Number(product.oldPrice);
  if (oldPrice && oldPrice > price) {
    return `<span class="price-old">${oldPrice} сом</span><span class="price-current">${price} сом</span>`;
  }
  return `<span class="price-current">${price} сом</span>`;
}

function renderCatalog() {
  const grid = document.getElementById('catalog');
  const empty = document.getElementById('catalogEmpty');
  const count = document.getElementById('catalogCount');

  const models = getFilteredCatalogModels();

  grid.className = 'catalog-grid';
  grid.innerHTML = '';

  if (count) {
    count.textContent = models.length
      ? `${models.length} ${pluralModels(models.length)}`
      : '0 моделей';
  }

  if (models.length === 0) {
    empty.classList.remove('hidden');
    const hasFilters = state.selectedCategoryId || (state.catalogSearchQuery || '').trim();
    empty.innerHTML = `
      <div class="empty-icon">📦</div>
      <div>${hasFilters ? 'Ничего не найдено' : 'Модели не найдены'}</div>`;
    return;
  }
  empty.classList.add('hidden');

  models.forEach(model => {
    const inStock = getModelInStock(model.id);
    const photoSrc = normalizePhotoSrc(model.photo);
    const priceInfo = getModelPriceInfo(model.id);
    const displayName = getModelDisplayName(model);
    const description = getModelCardDescription(model);

    const card = document.createElement('article');
    card.className = `product-card model-catalog-card${inStock ? '' : ' out-of-stock'}`;

    const photoWrap = document.createElement('div');
    photoWrap.className = 'product-photo-wrap';
    photoWrap.innerHTML = `
      <div class="product-photo-media">
        <img class="product-photo" src="${photoSrc}" alt="${escapeHtml(displayName)}"
          loading="lazy" onerror="this.src='/img/placeholder.svg'">
      </div>
      <div class="product-photo-badges">
        ${priceInfo.discountPercent > 0
          ? `<span class="product-badge product-badge-discount">−${priceInfo.discountPercent}%</span>`
          : ''}
        ${model.badge
          ? `<span class="product-badge product-badge-model">${escapeHtml(model.badge)}</span>`
          : ''}
        <span class="product-badge product-badge-stock ${inStock ? '' : 'out'}">${inStock ? 'В наличии' : 'Нет в наличии'}</span>
      </div>
      ${!inStock ? '<div class="out-of-stock-overlay">Нет в наличии</div>' : ''}
    `;
    photoWrap.addEventListener('click', () => openFlavorModal(model.id));

    const info = document.createElement('div');
    info.className = 'product-info';
    info.innerHTML = `
      <div class="product-name">${escapeHtml(displayName)}</div>
      <div class="product-desc">${escapeHtml(description)}</div>
      <div class="product-price-row">${formatModelPriceHtml(priceInfo)}</div>
    `;
    info.addEventListener('click', () => openFlavorModal(model.id));

    card.appendChild(photoWrap);
    card.appendChild(info);
    grid.appendChild(card);
  });
}

function openBrandCatalog(brandId) {
  openModelModal(brandId);
}

function openModelModal(brandId) {
  const cat = state.categories.find(c => Number(c.id) === Number(brandId));
  if (!cat) return;

  closeModal('flavorModal');
  state.modelModalBrandId = brandId;

  const titleEl = document.getElementById('modelModalTitle');
  const subtitleEl = document.getElementById('modelModalSubtitle');
  if (titleEl) titleEl.textContent = 'Выберите модель';
  if (subtitleEl) subtitleEl.textContent = cat.name;

  renderModelModalGrid(getFilteredBrandModels(brandId));
  openModal('modelModal');
}

function renderModelModalGrid(models) {
  const grid = document.getElementById('modelModalGrid');
  if (!grid) return;
  grid.innerHTML = '';

  if (models.length === 0) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📦</div><div>Модели не найдены</div></div>';
    return;
  }

  models.forEach(model => {
    const inStock = getModelInStock(model.id);
    const photoSrc = normalizePhotoSrc(model.photo);
    const priceLabel = getModelPriceRange(model.id) || '—';
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `model-pick-card${!inStock ? ' out-of-stock' : ''}`;
    card.onclick = () => openFlavorModal(model.id);
    card.innerHTML = `
      <div class="model-pick-photo-wrap">
        <img class="model-pick-photo" src="${photoSrc}" alt="${escapeHtml(model.name)}"
          loading="lazy" onerror="this.src='/img/placeholder.svg'">
        ${model.badge ? `<span class="model-pick-badge">${escapeHtml(model.badge)}</span>` : ''}
      </div>
      <span class="model-pick-name">${escapeHtml(model.name)}</span>
      <span class="model-pick-meta">${priceLabel}</span>
      <span class="model-pick-stock ${inStock ? 'in-stock' : 'out-of-stock-label'}">${inStock ? 'В наличии' : 'Нет в наличии'}</span>
    `;
    grid.appendChild(card);
  });
}

function getFilteredModalFlavors(modelId) {
  let flavors = getProductsByModel(modelId);
  if (!flavors.length) {
    const model = state.models.find(m => Number(m.id) === Number(modelId));
    if (model) {
      flavors = getProductsByCategory(model.brandId).filter(p => !p.modelId || Number(p.modelId) === Number(modelId));
    }
  }
  const q = (state.catalogSearchQuery || '').trim().toLowerCase();
  if (q) {
    flavors = flavors.filter(p => flavorMatchesSearch(p, q));
  }
  return flavors;
}

function openFlavorModal(modelId) {
  const model = state.models.find(m => Number(m.id) === Number(modelId));
  if (!model) return;

  closeModal('modelModal');
  state.flavorModalModelId = modelId;
  state.modelModalBrandId = model.brandId;

  const flavors = getFilteredModalFlavors(modelId);
  const firstPurchasable = flavors.find(isProductPurchasable);
  state.selectedFlavorId = firstPurchasable ? firstPurchasable.id : (flavors[0]?.id || null);

  const brand = state.categories.find(c => c.id === model.brandId);
  document.getElementById('flavorModalTitle').textContent = model.name;
  const subtitleEl = document.getElementById('flavorModalSubtitle');
  if (subtitleEl) subtitleEl.textContent = brand ? brand.name : '';

  renderFlavorModalGrid(flavors);
  updateFlavorModalActions();
  openModal('flavorModal');
}

function backToModelModal() {
  closeModal('flavorModal');
}

function renderFlavorModalGrid(flavors) {
  const grid = document.getElementById('flavorModalGrid');
  grid.innerHTML = '';

  if (flavors.length === 0) {
    grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📦</div><div>Нет вкусов</div></div>';
    return;
  }

  flavors.forEach(product => {
    const purchasable = isProductPurchasable(product);
    const selected = state.selectedFlavorId === product.id;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `flavor-pick-card${selected ? ' selected' : ''}${!purchasable ? ' out-of-stock' : ''}`;
    card.onclick = () => selectFlavor(product.id);
    card.innerHTML = `
      <span class="flavor-pick-emoji">${getFlavorEmoji(product)}</span>
      <span class="flavor-pick-name">${escapeHtml(product.name)}</span>
      ${product.description ? `<span class="flavor-pick-desc">${escapeHtml(product.description)}</span>` : ''}
      <span class="flavor-pick-stock ${purchasable ? 'in-stock' : 'out-of-stock-label'}">${purchasable ? 'В наличии' : 'Нет в наличии'}</span>
      ${selected ? '<span class="flavor-pick-check">✓</span>' : ''}
    `;
    grid.appendChild(card);
  });
}

function selectFlavor(productId) {
  state.selectedFlavorId = productId;
  renderFlavorModalGrid(getFilteredModalFlavors(state.flavorModalModelId));
  updateFlavorModalActions();
}

function updateFlavorModalActions() {
  const product = state.products.find(p => p.id === state.selectedFlavorId);
  const purchasable = isProductPurchasable(product);
  const addBtn = document.getElementById('flavorAddCartBtn');
  const buyBtn = document.getElementById('flavorBuyNowBtn');
  if (addBtn) addBtn.disabled = !purchasable;
  if (buyBtn) buyBtn.disabled = !purchasable;
}

function addSelectedFlavorToCart() {
  const productId = state.selectedFlavorId;
  if (!productId) return;
  const product = state.products.find(p => p.id === productId);
  if (!isProductPurchasable(product)) {
    showToast('Товар недоступен', 'error');
    return;
  }

  const stock = getAvailableStock(product);
  const existing = state.cart.find(c => c.id === productId);
  if (existing) {
    if (existing.qty >= stock) {
      showToast('Нельзя добавить больше', 'error');
      return;
    }
    existing.qty += 1;
    existing.price = getProductModelPrice(product);
    showToast('Количество обновлено ✓', 'success');
  } else {
    state.cart.push(cartItemFromProduct(product));
    showToast('Добавлено в корзину ✓', 'success');
  }
  updateCartUI();
  closeModal('flavorModal');
}

function buySelectedFlavorNow() {
  const productId = state.selectedFlavorId;
  if (!productId) return;
  closeModal('flavorModal');
  openBuyModal(productId);
}

function previewImage(src) {
  if (!src || src.includes('placeholder')) return;
  document.getElementById('imagePreviewImg').src = src;
  openModal('imagePreviewModal');
}

// ─── Cart ─────────────────────────────────────────────────────────────────────
function toggleCart(productId) {
  const product = state.products.find(p => p.id === productId);
  if (!isProductPurchasable(product)) return;

  const existing = state.cart.find(c => c.id === productId);
  if (existing) {
    state.cart = state.cart.filter(c => c.id !== productId);
    showToast('Убрано из корзины');
  } else {
    state.cart.push(cartItemFromProduct(product));
    showToast('Добавлено в корзину ✓', 'success');
  }
  updateCartUI();
}

function changeQty(productId, delta) {
  const item = state.cart.find(c => c.id === productId);
  if (!item) return;
  const product = state.products.find(p => p.id === productId);
  const stock = getAvailableStock(product);

  if (delta > 0 && item.qty >= stock) {
    showToast('Нельзя добавить больше', 'error');
    return;
  }

  if (product) item.price = getProductModelPrice(product);

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
  const payment = calcOrderPayment(subtotal, false);
  stickyTotal.textContent = `${payment.finalTotal} сом`;
  stickyCount.textContent = totalItems;

  // Checkout button
  if (checkoutBtn) checkoutBtn.disabled = state.cart.length === 0;

  scheduleCartSync();
}

function openBuyModal(productId) {
  const product = state.products.find(p => p.id === productId);
  if (!isProductPurchasable(product)) return;

  state.buyProductId = productId;
  state.buyUseBalance = false;
  const categoryName = getCategoryName(product.categoryId);
  const summary = document.getElementById('buyOrderSummary');
  summary.innerHTML = `
    <div><strong>${escapeHtml(categoryName)}</strong></div>
    <div class="buy-summary-row buy-summary-flavor">${escapeHtml(product.name)}</div>
    ${product.description ? `<div class="buy-summary-row buy-summary-desc">${escapeHtml(product.description)}</div>` : ''}
    <div class="buy-summary-row">${formatProductPriceHtml(product)}</div>
  `;

  document.getElementById('buyPhone').value = '';
  document.getElementById('buyAddress').value = '';
  document.getElementById('buyComment').value = '';
  const buyCb = document.getElementById('buyUseBalance');
  if (buyCb) buyCb.checked = false;

  refreshUserBalance().then(() => {
    updateBalanceToggleUI('buy', getProductModelPrice(product));
    updateBuyOrderTotals();
  });

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
  const unitPrice = getProductModelPrice(product);
  const payment = calcOrderPayment(unitPrice, state.buyUseBalance);
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
      price: unitPrice,
      qty: 1
    }],
    total: payment.subtotal,
    useBalance: payment.balanceUsed,
    finalTotal: payment.finalTotal
  };

  try {
    const result = await submitOrderViaAPI(orderData);
    if (typeof result.newBalance === 'number') state.userBalance = result.newBalance;
    state.promoDiscount = 0;
    state.pendingFreeOrder = false;
    await refreshUserBalance();
    closeModal('buyOrderModal');
    state.buyProductId = null;
    state.buyUseBalance = false;
    await loadProducts();
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
  state.cartUseBalance = false;
  const cb = document.getElementById('cartUseBalance');
  if (cb) cb.checked = false;
  refreshUserBalance().then(() => renderCartItems());
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
  const checkoutFields = document.getElementById('cartCheckoutFields');

  container.innerHTML = '';

  if (state.cart.length === 0) {
    empty.classList.remove('hidden');
    footer.style.display = 'none';
    if (checkoutFields) checkoutFields.style.display = 'none';
    return;
  }

  empty.classList.add('hidden');
  footer.style.display = '';
  if (checkoutFields) checkoutFields.style.display = '';

  state.cart.forEach(item => {
    const el = document.createElement('div');
    el.className = 'cart-item';
    el.innerHTML = `
      <img class="cart-item-photo" src="${item.photo}" alt="${item.name}"
        onerror="this.src='/img/placeholder.svg'">
      <div class="cart-item-info">
        <div class="cart-item-name">${escapeHtml(item.name)}</div>
        ${item.description ? `<div class="cart-item-desc">${escapeHtml(item.description)}</div>` : ''}
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
  const payment = calcOrderPayment(subtotal, state.cartUseBalance);

  subtotalEl.textContent = `${payment.subtotal} сом`;
  totalEl.textContent = `${payment.finalTotal} сом`;
  checkoutBtn.disabled = false;

  if (payment.freeOrder) {
    discountRow.classList.remove('hidden');
    discountDisplay.textContent = `Бесплатный заказ (−${payment.subtotal} сом)`;
  } else if (payment.discount > 0) {
    discountRow.classList.remove('hidden');
    discountDisplay.textContent = `промо −${payment.promoDiscount} сом`;
  } else {
    discountRow.classList.add('hidden');
  }

  updateBalanceToggleUI('cart', subtotal);
  const balanceRow = document.getElementById('cartBalanceRow');
  const balanceUsedEl = document.getElementById('cartBalanceUsed');
  if (balanceRow && balanceUsedEl) {
    if (payment.balanceUsed > 0) {
      balanceRow.classList.remove('hidden');
      balanceUsedEl.textContent = `−${payment.balanceUsed} сом`;
    } else {
      balanceRow.classList.add('hidden');
    }
  }
}

// ─── Checkout ─────────────────────────────────────────────────────────────────
async function checkout() {
  if (state.cart.length === 0) {
    showToast('Корзина пуста', 'error');
    return;
  }

  const phone = document.getElementById('cartPhone')?.value?.trim();
  const address = document.getElementById('cartAddress')?.value?.trim();
  if (!phone || !address) {
    showToast('Заполните телефон и адрес', 'error');
    return;
  }

  const tgUser = tg?.initDataUnsafe?.user;
  const subtotal = state.cart.reduce((s, c) => s + c.price * c.qty, 0);
  const payment = calcOrderPayment(subtotal, state.cartUseBalance);

  const orderData = {
    userId: tgUser?.id || null,
    userName: tgUser ? `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim() : 'Аноним',
    username: tgUser?.username || '',
    phone,
    address,
    items: state.cart.map(c => ({
      id: c.id,
      name: c.name,
      description: c.description || c.name,
      categoryId: c.categoryId,
      price: c.price,
      qty: c.qty
    })),
    total: payment.subtotal,
    useBalance: payment.balanceUsed,
    finalTotal: payment.finalTotal
  };

  closeModal('cartModal');

  const savedCart = [...state.cart];
  const useApiFlow = payment.balanceUsed > 0 || state.pendingFreeOrder || state.promoDiscount > 0
    || !(tg && tg.sendData && tg.initDataUnsafe?.user);

  const finishCheckout = async () => {
    state.cart = [];
    state.cartUseBalance = false;
    syncCartToServer();
    updateCartUI();
    await loadProducts();
    showOrderSuccess(orderData, savedCart);
  };

  if (useApiFlow) {
    try {
      const result = await submitOrderViaAPI(orderData);
      if (typeof result.newBalance === 'number') state.userBalance = result.newBalance;
      state.promoDiscount = 0;
      state.pendingFreeOrder = false;
      await refreshUserBalance();
      await finishCheckout();
    } catch (err) {
      showToast(err.message || 'Ошибка оформления заказа', 'error');
    }
    return;
  }

  if (tg && tg.sendData && tg.initDataUnsafe?.user) {
    try {
      tg.sendData(JSON.stringify(orderData));
    } catch {
      await submitOrderViaAPI(orderData);
    }
    await finishCheckout();
  } else {
    try {
      await submitOrderViaAPI(orderData);
      await finishCheckout();
    } catch (err) {
      showToast(err.message || 'Ошибка оформления заказа', 'error');
    }
  }
}

function requestBrowserGeolocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Геолокация недоступна'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => reject(new Error('Не удалось получить геопозицию')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}

function requestUserCoordinates() {
  return new Promise((resolve, reject) => {
    const lm = tg?.LocationManager;
    if (lm && typeof lm.init === 'function') {
      try {
        lm.init(() => {
          if (lm.isLocationAvailable && typeof lm.getLocation === 'function') {
            lm.getLocation((location) => {
              if (location?.latitude != null && location?.longitude != null) {
                resolve({ lat: location.latitude, lon: location.longitude });
              } else {
                requestBrowserGeolocation().then(resolve).catch(reject);
              }
            });
          } else {
            requestBrowserGeolocation().then(resolve).catch(reject);
          }
        });
        return;
      } catch {
        // fall through to browser API
      }
    }
    requestBrowserGeolocation().then(resolve).catch(reject);
  });
}

async function reverseGeocode(lat, lon) {
  try {
    const res = await fetch(`${API}/geocode/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.address) return data.address;
    }
  } catch {}
  return `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
}

async function fillAddressFromGeolocation(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input) return;

  const originalHtml = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳';
  }

  try {
    const coords = await requestUserCoordinates();
    const address = await reverseGeocode(coords.lat, coords.lon);
    input.value = address;
    showToast('Адрес определён ✓', 'success');
  } catch (err) {
    showToast(err.message || 'Не удалось определить адрес', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml || '📍';
    }
  }
}

async function submitOrderViaAPI(orderData) {
  const initData = getTelegramInitData();
  const headers = { 'Content-Type': 'application/json' };
  if (initData) headers['x-telegram-init-data'] = initData;
  const res = await fetch(`${API}/orders`, {
    method: 'POST',
    headers,
    body: JSON.stringify(orderData)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}

function showOrderSuccess(orderData, cartItems) {
  // Build order summary
  const infoEl = document.getElementById('successOrderInfo');
  if (infoEl && cartItems && cartItems.length > 0) {
    const lines = cartItems.map(c => `• ${c.name} ×${c.qty} — ${c.price * c.qty} сом`).join('<br>');
    const discountLine = orderData.discount > 0
      ? `<br><span style="color:#4ade80">🎁 Скидка: −${orderData.discount} сом</span>` : '';
    const balanceLine = orderData.useBalance > 0
      ? `<br><span style="color:#4ade80">💳 С баланса: −${orderData.useBalance} сом</span>` : '';
    infoEl.innerHTML = `${lines}${discountLine}${balanceLine}<br><strong style="color:#fff">Итого: ${orderData.finalTotal} сом</strong>`;
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
// WHEEL OF FORTUNE (server-side)
// ═══════════════════════════════════════════════════════════════

const WHEEL_PRIZE_CHANCES = [
  { prize: 20, chance: 60 },
  { prize: 50, chance: 25 },
  { prize: 150, chance: 10 },
  { prize: 300, chance: 5 }
];

const WHEEL_LOGICAL_SIZE = 320;

function getCssVar(name, fallback = '') {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function hexToRgb(hex) {
  const h = (hex || '').replace('#', '');
  if (h.length !== 6) return { r: 227, g: 30, b: 36 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

function accentRgba(alpha, gi = 1) {
  const { r, g, b } = hexToRgb(getCssVar('--accent', '#e31e24'));
  return `rgba(${r},${g},${b},${alpha * gi})`;
}

function getWheelSegments() {
  const fill = getCssVar('--accent', '#e31e24');
  const fillLight = getCssVar('--accent-light', '#ff4d52');
  const dark = getCssVar('--wheel-sector-dark', '#1a1a1a');
  const darkLight = getCssVar('--wheel-sector-dark-light', '#2e2e2e');
  return WHEEL_PRIZE_CHANCES.map(({ prize }, i) => ({
    label: String(prize),
    prize,
    fill: i % 2 === 0 ? fill : dark,
    fillLight: i % 2 === 0 ? fillLight : darkLight
  }));
}

function getAccentSparkleColors() {
  const accent = getCssVar('--accent', '#e31e24');
  const accentLight = getCssVar('--accent-light', '#ff4d52');
  return [accent, accentLight, '#ffffff', '#ffd700'];
}

function setupWheelCanvas(canvas) {
  if (!canvas || canvas.dataset.dprReady) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = WHEEL_LOGICAL_SIZE * dpr;
  canvas.height = WHEEL_LOGICAL_SIZE * dpr;
  canvas.style.width = `${WHEEL_LOGICAL_SIZE}px`;
  canvas.style.height = `${WHEEL_LOGICAL_SIZE}px`;
  canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  canvas.dataset.dprReady = '1';
}

function drawCrispWheelText(ctx, text, x, y, { font, fill = '#ffffff', stroke = 'rgba(0,0,0,0.85)', lineWidth = 2.5 }) {
  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lineWidth;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function renderWheelPrizesList() {
  const list = document.getElementById('wheelPrizesList');
  if (!list) return;
  list.innerHTML = WHEEL_PRIZE_CHANCES.map(({ prize, chance }) => `
    <div class="wheel-prize-row">
      <span class="wheel-prize-label">${prize} сом</span>
      <div class="wheel-prize-bar-track" aria-hidden="true">
        <div class="wheel-prize-bar-fill" style="width:${chance}%"></div>
      </div>
      <span class="wheel-prize-pct">${chance}%</span>
    </div>
  `).join('');
}

function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateCooldownDisplay(ms) {
  const timerEl = document.getElementById('spinCooldownTimer');
  if (timerEl) timerEl.textContent = formatCountdown(ms);
}

function updateRouletteUI({ canSpin, remainingMs, noAuth }) {
  const spinBtn = document.getElementById('spinBtn');
  const cooldown = document.getElementById('spinCooldown');

  if (noAuth) {
    if (spinBtn) {
      spinBtn.classList.remove('hidden');
      spinBtn.disabled = true;
      spinBtn.textContent = 'Откройте через Telegram';
    }
    cooldown?.classList.add('hidden');
    return;
  }

  if (canSpin) {
    spinBtn?.classList.remove('hidden');
    if (spinBtn) {
      spinBtn.disabled = state.spinning;
      spinBtn.textContent = 'Крутить';
    }
    cooldown?.classList.add('hidden');
  } else {
    if (spinBtn) spinBtn.disabled = true;
    cooldown?.classList.remove('hidden');
    updateCooldownDisplay(remainingMs || 0);
  }
}

function startRouletteCountdown() {
  if (state.rouletteTimerInterval) {
    clearInterval(state.rouletteTimerInterval);
    state.rouletteTimerInterval = null;
  }
  if (state.rouletteRemainingMs <= 0) return;

  state.rouletteTimerInterval = setInterval(() => {
    state.rouletteRemainingMs = Math.max(0, state.rouletteRemainingMs - 1000);
    updateCooldownDisplay(state.rouletteRemainingMs);
    if (state.rouletteRemainingMs <= 0) {
      clearInterval(state.rouletteTimerInterval);
      state.rouletteTimerInterval = null;
      refreshRouletteStatus();
    }
  }, 1000);
}

async function refreshRouletteStatus() {
  const initData = getTelegramInitData();
  if (!initData) {
    updateRouletteUI({ canSpin: false, remainingMs: 0, noAuth: true });
    return;
  }
  try {
    const res = await fetch(`${API}/roulette/status`, {
      headers: { 'x-telegram-init-data': initData }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка');
    state.rouletteRemainingMs = data.remainingMs || 0;
    updateRouletteUI(data);
    startRouletteCountdown();
  } catch {
    updateRouletteUI({ canSpin: false, remainingMs: 0, noAuth: false });
  }
}

function initBonusWheel() {
  const canvas = document.getElementById('wheelCanvas');
  setupWheelCanvas(canvas);
  renderWheelPrizesList();
  requestAnimationFrame(() => drawWheel(state.wheelRotation));
  renderLastWinBox();
  refreshRouletteStatus();
}

function saveLastWin(prize) {
  try {
    localStorage.setItem(LAST_WIN_KEY, JSON.stringify({ prize, at: Date.now() }));
  } catch {}
  renderLastWinBox();
}

function renderLastWinBox() {
  const box = document.getElementById('lastWinBox');
  const amountEl = document.getElementById('lastWinAmount');
  if (!box || !amountEl) return;

  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(LAST_WIN_KEY) || 'null');
  } catch {}

  if (!data || !data.prize) {
    box.classList.add('hidden');
    return;
  }

  amountEl.textContent = `${data.prize} сом`;
  box.classList.remove('hidden');
}

function drawWheel(rotation, glowIntensity = 1) {
  const canvas = document.getElementById('wheelCanvas');
  if (!canvas) return;
  setupWheelCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const W = WHEEL_LOGICAL_SIZE;
  const H = WHEEL_LOGICAL_SIZE;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(cx, cy) - 16;
  const gi = Math.max(0.25, glowIntensity);

  ctx.clearRect(0, 0, W, H);

  const halo = ctx.createRadialGradient(cx, cy, R, cx, cy, R + 14);
  halo.addColorStop(0, accentRgba(0));
  halo.addColorStop(0.85, accentRgba(0.08, gi));
  halo.addColorStop(1, accentRgba(0.18, gi));
  ctx.beginPath();
  ctx.arc(cx, cy, R + 14, 0, 2 * Math.PI);
  ctx.fillStyle = halo;
  ctx.fill();

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);

  const sectorAngle = (Math.PI * 2) / 4;
  let startAngle = -Math.PI / 2;
  const wheelSegments = getWheelSegments();

  wheelSegments.forEach(seg => {
    const midAngle = startAngle + sectorAngle / 2;
    const gx = Math.cos(midAngle) * R * 0.55;
    const gy = Math.sin(midAngle) * R * 0.55;
    const grad = ctx.createRadialGradient(0, 0, R * 0.08, gx, gy, R);
    grad.addColorStop(0, seg.fillLight);
    grad.addColorStop(1, seg.fill);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, startAngle, startAngle + sectorAngle);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();

    const tr = R * 0.58;
    const tx = Math.cos(midAngle) * tr;
    const ty = Math.sin(midAngle) * tr;

    ctx.save();
    ctx.translate(tx, ty);
    ctx.rotate(midAngle + Math.PI / 2);
    drawCrispWheelText(ctx, seg.label, 0, -10, {
      font: '800 32px Inter, Arial, sans-serif',
      lineWidth: 3
    });
    drawCrispWheelText(ctx, 'сом', 0, 16, {
      font: '700 11px Inter, Arial, sans-serif',
      lineWidth: 2
    });
    ctx.restore();

    startAngle += sectorAngle;
  });

  ctx.restore();

  ctx.shadowColor = accentRgba(0.4, gi);
  ctx.shadowBlur = 12 * gi;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, 2 * Math.PI);
  ctx.strokeStyle = accentRgba(0.95);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.beginPath();
  ctx.arc(cx, cy, R + 2, 0, 2 * Math.PI);
  ctx.strokeStyle = accentRgba(0.2);
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, 34, 0, 2 * Math.PI);
  ctx.fillStyle = '#0d0d0d';
  ctx.fill();
  ctx.restore();

  const hubOuter = ctx.createRadialGradient(cx - 5, cy - 6, 2, cx, cy, 30);
  hubOuter.addColorStop(0, '#3d3d3d');
  hubOuter.addColorStop(0.55, '#222');
  hubOuter.addColorStop(1, '#111');
  ctx.beginPath();
  ctx.arc(cx, cy, 30, 0, 2 * Math.PI);
  ctx.fillStyle = hubOuter;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, 30, 0, 2 * Math.PI);
  ctx.strokeStyle = accentRgba(0.45);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const hubAccent = getCssVar('--accent', '#e31e24');
  const hubAccentLight = getCssVar('--accent-light', '#ff4d52');
  const hubAccentDeep = getCssVar('--accent-deep', '#8f1418');
  const hubInner = ctx.createRadialGradient(cx - 3, cy - 4, 1, cx, cy, 16);
  hubInner.addColorStop(0, hubAccentLight);
  hubInner.addColorStop(0.45, hubAccent);
  hubInner.addColorStop(1, hubAccentDeep);
  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, 2 * Math.PI);
  ctx.fillStyle = hubInner;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx - 4, cy - 5, 4, 0, 2 * Math.PI);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fill();
}

function animateWheelToSector(sectorIndex, prize, onComplete) {
  const targetDeg = sectorIndex * 90 + 90 * (0.25 + Math.random() * 0.5);
  const extraSpins = 5 + Math.floor(Math.random() * 3);
  const finalRad = -(extraSpins * 360 + targetDeg) * Math.PI / 180;
  const startRot = state.wheelRotation;
  const startTime = performance.now();
  const duration = 5200;
  const canvas = document.getElementById('wheelCanvas');
  if (canvas) canvas.classList.add('spinning');

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 4);
  }

  function animate(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const eased = easeOut(t);
    state.wheelRotation = startRot + (finalRad - startRot) * eased;
    drawWheel(state.wheelRotation, 0.4 + (1 - t) * 0.8);

    if (t < 1) {
      requestAnimationFrame(animate);
    } else {
      if (canvas) canvas.classList.remove('spinning');
      state.wheelRotation = finalRad % (2 * Math.PI);
      drawWheel(state.wheelRotation, 1.4);
      onComplete(prize);
    }
  }

  requestAnimationFrame(animate);
}

async function spinWheel() {
  if (state.spinning) return;

  const initData = getTelegramInitData();
  if (!initData) {
    showToast('Откройте приложение через Telegram', 'error');
    return;
  }

  const spinBtn = document.getElementById('spinBtn');
  state.spinning = true;
  if (spinBtn) {
    spinBtn.disabled = true;
    spinBtn.textContent = 'Крутим…';
  }
  document.getElementById('spinResultBox')?.classList.add('hidden');
  document.getElementById('wheelWinGlow')?.classList.remove('active');

  try {
    const res = await fetch(`${API}/roulette/spin`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': initData }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.remainingMs) {
        state.rouletteRemainingMs = data.remainingMs;
        updateRouletteUI({ canSpin: false, remainingMs: data.remainingMs });
        startRouletteCountdown();
      }
      throw new Error(data.error || 'Не удалось крутить');
    }

    animateWheelToSector(data.sectorIndex, data.prize, async (prize) => {
      document.getElementById('wheelWinGlow')?.classList.add('active');

      const resultBox = document.getElementById('spinResultBox');
      const resultText = document.getElementById('spinResultText');
      const resultIcon = document.getElementById('spinResultIcon');
      const resultSub = document.getElementById('spinResultSub');
      if (resultBox && resultText) {
        const emojis = { 20: '🎉', 50: '🎊', 150: '✨', 300: '🏆' };
        if (resultIcon) resultIcon.textContent = emojis[prize] || '🎉';
        resultText.textContent = `Вы выиграли ${prize} сом`;
        if (resultSub) resultSub.textContent = 'Приз зачислен на баланс';
        resultBox.classList.remove('hidden');
        launchSparkles(resultBox);
        launchConfetti();
      }

      if (typeof data.balance === 'number') state.userBalance = data.balance;
      await refreshUserBalance();
      const balanceEl = document.getElementById('profileBalance');
      if (balanceEl) balanceEl.textContent = String(state.userBalance);

      state.rouletteRemainingMs = data.remainingMs || 24 * 60 * 60 * 1000;
      updateRouletteUI({ canSpin: false, remainingMs: state.rouletteRemainingMs });
      startRouletteCountdown();
      showToast(`🎉 +${prize} сом на баланс!`, 'success');
      saveLastWin(prize);

      state.spinning = false;
    });
  } catch (err) {
    state.spinning = false;
    if (spinBtn) {
      spinBtn.disabled = false;
      spinBtn.textContent = 'Крутить';
    }
    showToast(err.message || 'Ошибка', 'error');
  }
}

function launchSparkles(container) {
  const sparkleEl = container.querySelector('.spin-sparkles');
  if (!sparkleEl) return;
  sparkleEl.innerHTML = '';
  const colors = getAccentSparkleColors();
  for (let i = 0; i < 20; i++) {
    const s = document.createElement('div');
    s.className = 'sparkle';
    const angle = Math.random() * 360;
    const dist = 50 + Math.random() * 90;
    s.style.cssText = `
      left: ${40 + Math.random() * 20}%;
      top: ${30 + Math.random() * 30}%;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      width: ${4 + Math.random() * 6}px;
      height: ${4 + Math.random() * 6}px;
      --dx: ${Math.cos(angle * Math.PI / 180) * dist}px;
      --dy: ${Math.sin(angle * Math.PI / 180) * dist}px;
      --dur: ${0.5 + Math.random() * 0.8}s;
      animation-delay: ${Math.random() * 0.2}s;
    `;
    sparkleEl.appendChild(s);
  }
}

function launchConfetti() {
  const container = document.getElementById('bonusView');
  if (!container) return;
  const colors = getAccentSparkleColors();
  for (let i = 0; i < 40; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    const size = 5 + Math.random() * 8;
    piece.style.cssText = `
      left: ${Math.random() * 100}%;
      top: -12px;
      width: ${size}px;
      height: ${size * 0.5}px;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      border-radius: 2px;
      animation-delay: ${Math.random() * 0.6}s;
      animation-duration: ${1.0 + Math.random() * 1.0}s;
      --spin: ${Math.random() > 0.5 ? '' : '-'}${360 + Math.random() * 720}deg;
      --dx: ${(Math.random() - 0.5) * 100}px;
    `;
    container.appendChild(piece);
    setTimeout(() => piece.remove(), 2500);
  }
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
  else if (tab === 'promocodes') loadAdminPromocodes();
  else if (tab === 'banner') loadAdminBanner();
}

async function loadAdminBanner() {
  try {
    const data = await api('GET', '/banner');
    state.banner = data;
    document.getElementById('adminBannerTag').value = data.tag || '';
    document.getElementById('adminBannerTitle').value = data.title || '';
    document.getElementById('adminBannerSubtitle').value = data.subtitle || '';
    document.getElementById('adminBannerButton').value = data.buttonText || '';
    updateAdminBannerBgPreview(data.bgImage || '');
    const bgInput = document.getElementById('adminBannerBgImage');
    if (bgInput) bgInput.value = '';
  } catch {
    showToast('Не удалось загрузить баннер', 'error');
  }
}

function updateAdminBannerBgPreview(bgImage) {
  const preview = document.getElementById('adminBannerBgPreview');
  const nameEl = document.getElementById('adminBannerBgName');
  const removeBtn = document.getElementById('removeBannerBgBtn');
  if (bgImage) {
    const src = normalizePhotoSrc(bgImage);
    if (preview) {
      preview.innerHTML = `<img src="${src}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px;">`;
    }
    if (nameEl) nameEl.textContent = 'Фон установлен';
    removeBtn?.classList.remove('hidden');
  } else {
    if (preview) preview.textContent = '🖼';
    if (nameEl) nameEl.textContent = 'Выберите фон (необяз.)';
    removeBtn?.classList.add('hidden');
  }
}

function previewAdminBannerBg(input) {
  if (!input.files[0]) return;
  const name = input.files[0].name;
  const nameEl = document.getElementById('adminBannerBgName');
  if (nameEl) {
    nameEl.textContent = name.length > 24 ? name.slice(0, 24) + '...' : name;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const preview = document.getElementById('adminBannerBgPreview');
    if (preview) {
      preview.innerHTML = `<img src="${e.target.result}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px;">`;
    }
  };
  reader.readAsDataURL(input.files[0]);
}

async function saveBannerSettings(e) {
  e.preventDefault();
  const btn = document.getElementById('saveBannerBtn');
  const fd = new FormData();
  fd.append('tag', document.getElementById('adminBannerTag').value.trim());
  fd.append('title', document.getElementById('adminBannerTitle').value.trim());
  fd.append('subtitle', document.getElementById('adminBannerSubtitle').value.trim());
  fd.append('buttonText', document.getElementById('adminBannerButton').value.trim());
  const bgInput = document.getElementById('adminBannerBgImage');
  if (bgInput?.files[0]) fd.append('bgImage', bgInput.files[0]);

  if (btn) { btn.disabled = true; btn.textContent = 'Сохранение...'; }
  try {
    const data = await adminFormFetch('PUT', `${API}/banner`, fd);
    state.banner = data;
    updateAdminBannerBgPreview(data.bgImage || '');
    if (bgInput) bgInput.value = '';
    renderCatalogBanner();
    showToast('Баннер сохранён ✓', 'success');
  } catch (err) {
    showToast('Ошибка: ' + (err.message || 'не удалось сохранить'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
  }
}

async function removeBannerBg() {
  const btn = document.getElementById('removeBannerBgBtn');
  const fd = new FormData();
  fd.append('tag', document.getElementById('adminBannerTag').value.trim());
  fd.append('title', document.getElementById('adminBannerTitle').value.trim());
  fd.append('subtitle', document.getElementById('adminBannerSubtitle').value.trim());
  fd.append('buttonText', document.getElementById('adminBannerButton').value.trim());
  fd.append('removeBgImage', 'true');
  if (btn) btn.disabled = true;
  try {
    const data = await adminFormFetch('PUT', `${API}/banner`, fd);
    state.banner = data;
    updateAdminBannerBgPreview('');
    const bgInput = document.getElementById('adminBannerBgImage');
    if (bgInput) bgInput.value = '';
    renderCatalogBanner();
    showToast('Фон баннера удалён ✓', 'success');
  } catch (err) {
    showToast('Ошибка: ' + (err.message || 'не удалось удалить фон'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// ADMIN — PRODUCTS & CATEGORIES
// ═══════════════════════════════════════════════════════════════

function populateCategorySelects() {
  populateAddProductBrandSelect();
  populateAddModelBrandSelect();
  populateAdminModelsFilterSelect();
}

function populateAddProductBrandSelect() {
  const addSelect = document.getElementById('addProductBrand');
  if (!addSelect) return;
  const current = addSelect.value;
  addSelect.innerHTML = '<option value="">Выберите бренд</option>' +
    state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (current) addSelect.value = current;
  onAddProductBrandChange();
}

function populateAddModelBrandSelect() {
  const addSelect = document.getElementById('addModelBrand');
  if (!addSelect) return;
  const current = addSelect.value;
  addSelect.innerHTML = '<option value="">Выберите бренд</option>' +
    state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (current) addSelect.value = current;
}

function populateAdminModelsFilterSelect() {
  const filterSelect = document.getElementById('adminModelsFilterBrand');
  if (!filterSelect) return;
  const current = state.adminModelsFilterBrandId || filterSelect.value;
  filterSelect.innerHTML = '<option value="">Все бренды</option>' +
    state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  filterSelect.value = current || '';
  state.adminModelsFilterBrandId = filterSelect.value;
}

function onAddProductBrandChange() {
  const brandId = document.getElementById('addProductBrand')?.value;
  const modelSelect = document.getElementById('addProductModel');
  if (!modelSelect) return;
  const models = brandId ? getModelsByBrand(brandId) : [];
  modelSelect.innerHTML = models.length
    ? '<option value="">Выберите модель</option>' +
      models.map(m => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')
    : '<option value="">Нет моделей — создайте модель</option>';
}

function onAdminModelsFilterChange(brandId) {
  state.adminModelsFilterBrandId = brandId || '';
  renderAdminModels();
}

function populateAdminProductsFilterSelects() {
  const brandSelect = document.getElementById('adminProductsFilterBrand');
  const modelSelect = document.getElementById('adminProductsFilterModel');
  if (!brandSelect || !modelSelect) return;

  const brandCurrent = state.adminProductsFilterBrandId || brandSelect.value;
  brandSelect.innerHTML = '<option value="">Все бренды</option>' +
    state.categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  brandSelect.value = brandCurrent || '';
  state.adminProductsFilterBrandId = brandSelect.value;

  const models = brandCurrent
    ? getModelsByBrand(brandCurrent)
    : state.models;
  const modelCurrent = state.adminProductsFilterModelId || modelSelect.value;
  modelSelect.innerHTML = '<option value="">Все модели</option>' +
    models.map(m => `<option value="${m.id}">${escapeHtml(m.name)} (${escapeHtml(getCategoryName(m.brandId))})</option>`).join('');
  if (modelCurrent && models.some(m => String(m.id) === String(modelCurrent))) {
    modelSelect.value = modelCurrent;
  } else {
    modelSelect.value = '';
    state.adminProductsFilterModelId = '';
  }

  const flavorInput = document.getElementById('adminProductsFilterFlavor');
  if (flavorInput && flavorInput.value !== state.adminProductsFilterFlavor) {
    flavorInput.value = state.adminProductsFilterFlavor || '';
  }
}

function onAdminProductsFilterChange() {
  const prevBrand = state.adminProductsFilterBrandId;
  state.adminProductsFilterBrandId = document.getElementById('adminProductsFilterBrand')?.value || '';
  if (state.adminProductsFilterBrandId !== prevBrand) {
    state.adminProductsFilterModelId = '';
  } else {
    state.adminProductsFilterModelId = document.getElementById('adminProductsFilterModel')?.value || '';
  }
  state.adminProductsFilterFlavor = document.getElementById('adminProductsFilterFlavor')?.value || '';
  populateAdminProductsFilterSelects();
  renderAdminProducts();
}

function getFilteredAdminProducts() {
  let list = state.products;
  if (state.adminProductsFilterBrandId) {
    list = list.filter(p => Number(p.categoryId) === Number(state.adminProductsFilterBrandId));
  }
  if (state.adminProductsFilterModelId) {
    list = list.filter(p => Number(p.modelId) === Number(state.adminProductsFilterModelId));
  }
  const q = (state.adminProductsFilterFlavor || '').trim().toLowerCase();
  if (q) {
    list = list.filter(p =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q)
    );
  }
  return list;
}

async function loadAdminProducts() {
  try {
    const [products, categories, models] = await Promise.all([
      api('GET', '/products'),
      api('GET', '/categories'),
      api('GET', '/models')
    ]);
    state.products = products;
    state.categories = categories;
    state.models = Array.isArray(models) ? models : [];
    populateCategorySelects();
    populateAdminProductsFilterSelects();
    renderAdminCategories();
    renderAdminModels();
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
    const item = document.createElement('div');
    item.className = 'admin-category-item';
    item.id = `adminCategory_${cat.id}`;
    item.innerHTML = `
      <div class="admin-category-name" id="catNameDisplay_${cat.id}">${escapeHtml(cat.name)}</div>
      <span class="admin-category-count">${count} вкус(ов)</span>
      <div id="catEditRow_${cat.id}" class="inline-edit-row hidden">
        <input type="text" class="form-input" id="catNameInput_${cat.id}" value="${escapeHtml(cat.name)}">
        <button class="btn-primary btn-sm" onclick="saveCategoryName(${cat.id})">✓</button>
        <button class="btn-sm btn-sm-grey" onclick="cancelCategoryEdit(${cat.id})">✕</button>
      </div>
      <button class="btn-sm btn-sm-red" onclick="toggleCategoryEdit(${cat.id})">✏️</button>
      <button class="btn-sm btn-sm-red" onclick="deleteCategory(${cat.id})">🗑</button>
    `;
    list.appendChild(item);
  });
}

function renderAdminModels() {
  const list = document.getElementById('adminModelsList');
  if (!list) return;
  list.innerHTML = '';

  let models = state.models;
  if (state.adminModelsFilterBrandId) {
    models = models.filter(m => Number(m.brandId) === Number(state.adminModelsFilterBrandId));
  }

  if (models.length === 0) {
    list.innerHTML = '<div class="empty-state" style="padding:16px"><div>Нет моделей</div></div>';
    return;
  }

  models.forEach(model => {
    const count = getModelProductCount(model.id);
    const photoSrc = normalizePhotoSrc(model.photo);
    const item = document.createElement('div');
    item.className = 'admin-category-item';
    item.id = `adminModel_${model.id}`;
    item.innerHTML = `
      <img class="admin-category-photo" src="${photoSrc}" alt="${escapeHtml(model.name)}"
        onclick="changeModelPhoto(${model.id})" title="Нажмите чтобы изменить фото"
        onerror="this.src='/img/placeholder.svg'">
      <div class="admin-category-name" id="modelNameDisplay_${model.id}">${escapeHtml(model.name)}</div>
      <span class="admin-category-count">${formatModelAdminPrice(model)} · ${escapeHtml(getCategoryName(model.brandId))} · ${count} вкус(ов)</span>
      <div id="modelEditRow_${model.id}" class="inline-edit-row hidden">
        <input type="text" class="form-input" id="modelNameInput_${model.id}" value="${escapeHtml(model.name)}">
        <button class="btn-primary btn-sm" onclick="saveModelName(${model.id})">✓</button>
        <button class="btn-sm btn-sm-grey" onclick="cancelModelEdit(${model.id})">✕</button>
      </div>
      <div class="form-group" style="margin-top:6px;flex:1 1 100%;min-width:140px">
        <label style="font-size:11px;color:var(--grey)">Метка</label>
        <div class="inline-edit-row" style="margin-top:4px">
          <input type="text" class="form-input" id="modelBadgeInput_${model.id}"
            value="${escapeHtml(model.badge || '')}" placeholder="NEW, HIT">
          <button class="btn-primary btn-sm" onclick="saveModelBadge(${model.id})">✓</button>
        </div>
      </div>
      <div id="modelPriceEditRow_${model.id}" class="inline-edit-row hidden" style="flex:1 1 100%;margin-top:6px">
        <input type="number" class="form-input" id="modelPriceInput_${model.id}"
          value="${model.price || ''}" placeholder="Цена" min="1">
        <input type="number" class="form-input" id="modelOldPriceInput_${model.id}"
          value="${model.oldPrice || ''}" placeholder="Старая цена" min="1">
        <button class="btn-primary btn-sm" onclick="saveModelPrice(${model.id})">✓</button>
        <button class="btn-sm btn-sm-grey" onclick="cancelModelPriceEdit(${model.id})">✕</button>
      </div>
      <button class="btn-sm btn-sm-grey" onclick="toggleModelPriceEdit(${model.id})">💰 Цена</button>
      <button class="btn-sm btn-sm-grey" onclick="changeModelPhoto(${model.id})">🖼 Фото</button>
      <button class="btn-sm btn-sm-red" onclick="toggleModelEdit(${model.id})">✏️</button>
      <button class="btn-sm btn-sm-red" onclick="deleteModel(${model.id})">🗑</button>
    `;
    list.appendChild(item);
  });
}

function formatModelAdminPrice(model) {
  const price = Number(model?.price);
  if (!Number.isFinite(price) || price < 1) return 'Цена не задана';
  const oldPrice = Number(model?.oldPrice);
  if (oldPrice && oldPrice > price) {
    return `${price} сом (было ${oldPrice})`;
  }
  return `${price} сом`;
}

function toggleModelPriceEdit(id) {
  document.getElementById(`modelPriceEditRow_${id}`)?.classList.toggle('hidden');
}

function cancelModelPriceEdit(id) {
  const model = state.models.find(m => m.id === id);
  document.getElementById(`modelPriceEditRow_${id}`)?.classList.add('hidden');
  const priceInput = document.getElementById(`modelPriceInput_${id}`);
  const oldInput = document.getElementById(`modelOldPriceInput_${id}`);
  if (model && priceInput) priceInput.value = model.price || '';
  if (model && oldInput) oldInput.value = model.oldPrice || '';
}

async function saveModelPrice(id) {
  const priceInput = document.getElementById(`modelPriceInput_${id}`);
  const oldInput = document.getElementById(`modelOldPriceInput_${id}`);
  const price = parseInt(priceInput?.value, 10);
  if (!price || price < 1) { showToast('Введите корректную цену', 'error'); return; }
  const body = { price };
  const oldVal = oldInput?.value?.trim();
  body.oldPrice = oldVal || '';
  try {
    await api('PUT', `/models/${id}`, body, true);
    showToast('Цена модели обновлена ✓', 'success');
    await loadAdminProducts();
    if (state.selectedCategoryId) renderCatalog();
  } catch (err) {
    showToast(err.message || 'Ошибка', 'error');
  }
}

async function addModel(e) {
  e.preventDefault();
  const form = e.target;
  const name = document.getElementById('addModelName')?.value?.trim()
    || form.elements['modelName']?.value?.trim();
  const brandId = document.getElementById('addModelBrand')?.value
    || form.elements['brandId']?.value;
  if (!name) { showToast('Введите название модели', 'error'); return; }
  if (!brandId) { showToast('Выберите бренд', 'error'); return; }
  const price = parseInt(document.getElementById('addModelPrice')?.value || form.elements['price']?.value, 10);
  if (!price || price < 1) { showToast('Введите цену модели', 'error'); return; }

  const btn = form.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Сохранение...'; }

  const fd = new FormData();
  fd.append('name', name);
  fd.append('brandId', brandId);
  fd.append('price', price);
  const oldPrice = document.getElementById('addModelOldPrice')?.value?.trim()
    || form.elements['oldPrice']?.value?.trim();
  if (oldPrice) fd.append('oldPrice', oldPrice);
  const badge = form.elements['badge']?.value?.trim();
  if (badge) fd.append('badge', badge);
  const fileInput = document.getElementById('addModelPhoto');
  if (fileInput?.files[0]) fd.append('photo', fileInput.files[0]);

  try {
    await adminFormFetch('POST', `${API}/models`, fd);
    showToast(`Модель «${name}» добавлена ✓`, 'success');
    form.reset();
    if (fileInput) fileInput.value = '';
    const preview = document.getElementById('addModelPhotoPreview');
    const photoName = document.getElementById('addModelPhotoName');
    if (preview) preview.textContent = '📷';
    if (photoName) photoName.textContent = 'Выберите фото (необяз.)';
    state.adminModelsFilterBrandId = String(brandId);
    await loadAdminProducts();
  } catch (err) {
    showToast('Ошибка: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '➕ Добавить модель'; }
  }
}

function previewAddModelPhoto(input) {
  if (!input.files[0]) return;
  const name = input.files[0].name;
  document.getElementById('addModelPhotoName').textContent =
    name.length > 20 ? name.slice(0, 20) + '...' : name;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('addModelPhotoPreview').innerHTML =
      `<img src="${e.target.result}" style="width:36px;height:36px;object-fit:cover;border-radius:6px;">`;
  };
  reader.readAsDataURL(input.files[0]);
}

function toggleModelEdit(id) {
  document.getElementById(`modelEditRow_${id}`)?.classList.toggle('hidden');
  document.getElementById(`modelNameDisplay_${id}`)?.classList.toggle('hidden');
}

function cancelModelEdit(id) {
  document.getElementById(`modelEditRow_${id}`)?.classList.add('hidden');
  document.getElementById(`modelNameDisplay_${id}`)?.classList.remove('hidden');
  const model = state.models.find(m => m.id === id);
  const input = document.getElementById(`modelNameInput_${id}`);
  if (model && input) input.value = model.name;
}

async function saveModelName(id) {
  const input = document.getElementById(`modelNameInput_${id}`);
  const name = input?.value.trim();
  if (!name) { showToast('Введите название', 'error'); return; }
  try {
    await api('PUT', `/models/${id}`, { name }, true);
    showToast('Модель переименована ✓', 'success');
    await loadAdminProducts();
  } catch (err) {
    showToast(err.message || 'Ошибка', 'error');
  }
}

async function saveModelBadge(id) {
  const input = document.getElementById(`modelBadgeInput_${id}`);
  const badge = input?.value?.trim() || '';
  try {
    await api('PUT', `/models/${id}`, { badge }, true);
    showToast('Метка обновлена ✓', 'success');
    await loadAdminProducts();
  } catch (err) {
    showToast(err.message || 'Ошибка', 'error');
  }
}

async function deleteModel(id) {
  const model = state.models.find(m => m.id === id);
  const count = getModelProductCount(id);
  if (count > 0) {
    showToast(`Нельзя удалить «${model?.name}»: привязано ${count} вкус(ов)`, 'error');
    return;
  }
  if (!confirm(`Удалить модель «${model?.name}»?`)) return;
  try {
    await api('DELETE', `/models/${id}`, null, true);
    showToast('Модель удалена', 'success');
    await loadAdminProducts();
  } catch (err) {
    showToast(err.message || 'Ошибка удаления', 'error');
  }
}

async function addCategory(e) {
  e.preventDefault();
  const form = e.target;
  const name = form.elements['name']?.value?.trim() || document.getElementById('addCategoryName')?.value?.trim();
  if (!name) { showToast('Введите название позиции', 'error'); return; }

  const fd = new FormData();
  fd.append('name', name);

  try {
    await adminFormFetch('POST', `${API}/categories`, fd);
    showToast(`Позиция «${name}» добавлена ✓`, 'success');
    form.reset();
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
    if (state.selectedCategoryId) renderCatalog();
    else showCategoriesView();
  } catch (err) {
    showToast(err.message || 'Ошибка', 'error');
  }
}

async function saveCategoryBadge(id) {
  const input = document.getElementById(`catBadgeInput_${id}`);
  const badge = input?.value?.trim() || '';
  try {
    await api('PUT', `/categories/${id}`, { badge }, true);
    showToast('Метка обновлена ✓', 'success');
    await loadAdminProducts();
    if (state.selectedCategoryId) renderCatalog();
    else showCategoriesView();
  } catch (err) {
    showToast(err.message || 'Ошибка', 'error');
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

  const products = getFilteredAdminProducts();

  if (state.products.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📦</div><div>Нет товаров</div></div>';
    return;
  }

  if (products.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><div>Ничего не найдено по фильтрам</div></div>';
    return;
  }

  products.forEach(product => {
    const model = getModelRecord(product.modelId);
    const modelPriceLabel = model ? formatModelAdminPrice(model) : '—';
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
          <span class="admin-product-price">Цена модели: ${modelPriceLabel}</span>
          <span class="status-pill available">${escapeHtml(getCategoryName(product.categoryId))}</span>
          <span class="status-pill available">${escapeHtml(getModelName(product.modelId))}</span>
          <span class="admin-product-sales">Продано: ${product.sales || 0}</span>
          <span class="status-pill ${isProductPurchasable(product) ? 'available' : 'unavailable'}">
            ${isProductPurchasable(product) ? 'В наличии' : 'Нет в наличии'}
          </span>
          <span class="admin-product-sales">Остаток: ${getProductStock(product)} шт${getProductReserved(product) ? ` (резерв: ${getProductReserved(product)})` : ''}</span>
        </div>
        <div class="form-group" style="margin-top:8px">
          <label style="font-size:11px;color:var(--grey)">Остаток (шт)</label>
          <div class="inline-edit-row" style="margin-top:4px">
            <input type="number" class="form-input" id="stockInput_${product.id}"
              value="${getProductStock(product)}" placeholder="0" min="0">
            <button class="btn-primary btn-sm" onclick="saveStock(${product.id})">✓</button>
          </div>
        </div>
        <div class="form-group" style="margin-top:8px">
          <label style="font-size:11px;color:var(--grey)">Бренд</label>
          <select class="form-input" id="brandSelect_${product.id}" onchange="changeProductBrand(${product.id}, this.value)">
            ${state.categories.map(c =>
              `<option value="${c.id}" ${c.id === product.categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group" style="margin-top:8px">
          <label style="font-size:11px;color:var(--grey)">Модель</label>
          <select class="form-input" id="modelSelect_${product.id}" onchange="changeProductModel(${product.id}, this.value)">
            ${getModelsByBrand(product.categoryId).map(m =>
              `<option value="${m.id}" ${Number(m.id) === Number(product.modelId) ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="admin-product-actions">
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

async function saveStock(id) {
  const input = document.getElementById(`stockInput_${id}`);
  const stock = Math.max(0, parseInt(input?.value, 10) || 0);

  try {
    const fd = new FormData();
    fd.append('stock', stock);
    await adminFormFetch('PUT', `${API}/products/${id}`, fd);
    showToast('Остаток обновлён ✓', 'success');
    await loadAdminProducts();
    if (state.selectedCategoryId) renderCatalog();
    else showCategoriesView();
  } catch {
    showToast('Ошибка обновления', 'error');
  }
}

async function changeProductBrand(id, brandId) {
  const models = getModelsByBrand(brandId);
  if (!models.length) {
    showToast('У бренда нет моделей — создайте модель', 'error');
    await loadAdminProducts();
    return;
  }
  const product = state.products.find(p => p.id === id);
  const keepModel = models.find(m => Number(m.id) === Number(product?.modelId));
  const modelId = keepModel ? keepModel.id : models[0].id;
  try {
    const fd = new FormData();
    fd.append('categoryId', parseInt(brandId, 10));
    fd.append('modelId', modelId);
    await adminFormFetch('PUT', `${API}/products/${id}`, fd);
    showToast('Бренд и модель обновлены ✓', 'success');
    await loadAdminProducts();
    if (state.selectedCategoryId) renderCatalog();
    else showCategoriesView();
  } catch {
    showToast('Ошибка обновления', 'error');
  }
}

async function changeProductModel(id, modelId) {
  try {
    const fd = new FormData();
    fd.append('modelId', parseInt(modelId, 10));
    await adminFormFetch('PUT', `${API}/products/${id}`, fd);
    showToast('Модель обновлена ✓', 'success');
    await loadAdminProducts();
    if (state.selectedCategoryId) renderCatalog();
    else showCategoriesView();
  } catch {
    showToast('Ошибка обновления модели', 'error');
  }
}

async function changeProductCategory(id, categoryId) {
  return changeProductBrand(id, categoryId);
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

let photoChangeModelId = null;
const modelPhotoInput = document.createElement('input');
modelPhotoInput.type = 'file';
modelPhotoInput.accept = 'image/*';
modelPhotoInput.style.display = 'none';
document.body.appendChild(modelPhotoInput);
modelPhotoInput.addEventListener('change', async function() {
  if (!this.files[0] || !photoChangeModelId) return;
  const fd = new FormData();
  fd.append('photo', this.files[0]);
  try {
    await adminFormFetch('PUT', `${API}/models/${photoChangeModelId}`, fd);
    showToast('Фото модели обновлено ✓', 'success');
    await loadAdminProducts();
  } catch {
    showToast('Ошибка загрузки фото', 'error');
  }
  this.value = '';
  photoChangeModelId = null;
});

function changeModelPhoto(id) {
  photoChangeModelId = id;
  modelPhotoInput.click();
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

  const name  = form.elements['name']?.value?.trim();
  const categoryId = form.elements['categoryId']?.value;
  const modelId = form.elements['modelId']?.value;
  if (!name)          { showToast('Введите название', 'error'); return; }
  if (!categoryId) { showToast('Выберите бренд', 'error'); return; }
  if (!modelId) { showToast('Выберите модель', 'error'); return; }

  const model = getModelRecord(modelId);
  if (!model?.price || model.price < 1) {
    showToast('Сначала укажите цену у модели', 'error');
    return;
  }

  const fd = new FormData();
  fd.append('name',  name);
  fd.append('categoryId', categoryId);
  fd.append('modelId', modelId);
  fd.append('description', form.elements['description']?.value?.trim() || '');
  const stockVal = form.elements['stock']?.value?.trim();
  if (stockVal !== undefined && stockVal !== '') fd.append('stock', stockVal);

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
    : allOrders.filter(o => normalizeOrderStatus(o.status) === state.ordersFilter);

  if (filtered.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  filtered.forEach(order => {
    const card = document.createElement('div');
    const orderStatus = normalizeOrderStatus(order.status);
    card.className = `order-card status-${orderStatus}`;
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
      <div class="order-comment-row">
        <label class="order-comment-label">💬 Комментарий${orderStatus === 'cancel' ? ' (обязателен при отмене)' : ''}</label>
        <textarea class="order-comment-input" id="orderComment_${order.id}" rows="2" placeholder="Комментарий к заказу">${escapeHtml(order.comment || '')}</textarea>
        <button type="button" class="btn-sm btn-sm-grey order-comment-save" onclick="saveOrderComment(${order.id})">Сохранить комментарий</button>
      </div>
      <div class="order-footer">
        <div>
          <div class="order-total">${order.finalTotal} сом</div>
          ${order.discount ? `<div class="order-discount">Скидка: −${order.discount} сом</div>` : ''}
        </div>
        <select class="order-status-select" onchange="updateOrderStatus(${order.id}, this.value, this)">
          <option value="new" ${orderStatus==='new'?'selected':''}>🆕 Новый</option>
          <option value="done" ${orderStatus==='done'?'selected':''}>✅ Выполнено</option>
          <option value="defect" ${orderStatus==='defect'?'selected':''}>⚠️ Брак</option>
          <option value="cancel" ${orderStatus==='cancel'?'selected':''}>❌ Отмена</option>
        </select>
      </div>
    `;
    list.appendChild(card);
  });
}

async function saveOrderComment(orderId) {
  const commentEl = document.getElementById(`orderComment_${orderId}`);
  const comment = commentEl ? commentEl.value.trim() : '';
  try {
    const updated = await api('PUT', `/orders/${orderId}/comment`, { comment }, true);
    const order = allOrders.find(o => o.id === orderId);
    if (order) order.comment = updated.comment || comment;
    showToast('Комментарий сохранён ✓', 'success');
  } catch (err) {
    showToast(err.message || 'Ошибка сохранения комментария', 'error');
  }
}

async function updateOrderStatus(orderId, status, selectEl) {
  const order = allOrders.find(o => o.id === orderId);
  const prevStatus = normalizeOrderStatus(order?.status);
  const commentEl = document.getElementById(`orderComment_${orderId}`);
  const comment = commentEl ? commentEl.value.trim() : String(order?.comment || '').trim();

  if (status === 'cancel' && !comment) {
    showToast('Для отмены заказа укажите комментарий', 'error');
    if (selectEl) selectEl.value = prevStatus;
    commentEl?.focus();
    return;
  }

  try {
    const updated = await api('PUT', `/orders/${orderId}/status`, { status, comment }, true);
    if (order) {
      order.status = updated.status || status;
      order.comment = updated.comment ?? comment;
    }
    renderOrders();
    updateNewOrdersBadge();
    showToast('Статус обновлён ✓', 'success');
  } catch (err) {
    if (selectEl) selectEl.value = prevStatus;
    showToast(err.message || 'Ошибка обновления статуса', 'error');
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
    await loadReferralBonusSettings();
    const stats = await api('GET', '/stats', null, true);
    const products = await api('GET', '/products');
    renderStats(stats, products);
  } catch {
    showToast('Ошибка загрузки статистики', 'error');
  }
}

async function loadReferralBonusSettings() {
  try {
    const data = await api('GET', '/settings');
    const input = document.getElementById('adminReferralBonus');
    if (input) input.value = data.referralBonus ?? 30;
  } catch {}
}

async function saveReferralBonusSettings() {
  const input = document.getElementById('adminReferralBonus');
  const btn = document.getElementById('saveReferralBonusBtn');
  const bonus = parseInt(input?.value, 10);
  if (!Number.isFinite(bonus) || bonus < 0) {
    showToast('Введите корректную сумму', 'error');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Сохранение...'; }
  try {
    const data = await api('PUT', '/settings', { referralBonus: bonus }, true);
    if (input) input.value = data.referralBonus;
    updateReferralBonusDisplay(data.referralBonus);
    showToast('Реферальный бонус сохранён ✓', 'success');
  } catch (err) {
    showToast('Ошибка: ' + (err.message || 'не удалось сохранить'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Сохранить'; }
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
// ADMIN — PROMOCODES
// ═══════════════════════════════════════════════════════════════

const PROMO_TYPE_LABELS = {
  balance: 'Баланс',
  discount: 'Скидка',
  free_order: 'Бесплатный заказ'
};

async function loadAdminPromocodes() {
  try {
    const promos = await api('GET', '/promocodes', null, true);
    renderAdminPromocodes(promos);
  } catch {
    showToast('Ошибка загрузки промокодов', 'error');
  }
}

function renderAdminPromocodes(promos) {
  const list = document.getElementById('adminPromocodesList');
  if (!list) return;
  if (!promos.length) {
    list.innerHTML = '<div class="empty-state" style="padding:20px"><div>Промокодов пока нет</div></div>';
    return;
  }
  list.innerHTML = promos.map(p => {
    const used = (p.activatedBy || []).length;
    const limit = Number(p.maxActivations) || 0;
    const limitText = limit > 0 ? `${used}/${limit}` : `${used} / ∞`;
    const valueText = p.type === 'free_order' ? '—' : `${p.value} сом`;
    return `
      <div class="admin-promo-item">
        <div class="admin-promo-main">
          <div class="admin-promo-code">${escapeHtml(p.code)}</div>
          <div class="admin-promo-meta">${PROMO_TYPE_LABELS[p.type] || p.type} · ${valueText} · активаций: ${limitText}</div>
        </div>
        <button class="btn-sm btn-sm-red" type="button" data-code="${escapeHtml(p.code)}" onclick="deletePromocode(this.dataset.code)">🗑</button>
      </div>
    `;
  }).join('');
}

async function addPromocode(e) {
  e.preventDefault();
  const code = document.getElementById('addPromoCode').value.trim();
  const type = document.getElementById('addPromoType').value;
  const value = parseInt(document.getElementById('addPromoValue').value, 10) || 0;
  const maxActivations = parseInt(document.getElementById('addPromoLimit').value, 10) || 1;
  try {
    await api('POST', '/promocodes', { code, type, value, maxActivations }, true);
    document.getElementById('addPromoForm').reset();
    document.getElementById('addPromoLimit').value = '1';
    showToast('Промокод создан ✓', 'success');
    loadAdminPromocodes();
  } catch (err) {
    showToast(err.message || 'Ошибка создания', 'error');
  }
}

async function deletePromocode(code) {
  if (!confirm(`Удалить промокод ${code}?`)) return;
  try {
    await api('DELETE', `/promocodes/${encodeURIComponent(code)}`, null, true);
    showToast('Промокод удалён', 'success');
    loadAdminPromocodes();
  } catch (err) {
    showToast(err.message || 'Ошибка удаления', 'error');
  }
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
