(() => {
'use strict';

const APP_VERSION = '1.4.4';
const EXPIRY_REVIEW_START = '2026-07-01';
const C = window.APP_CONFIG || {};
const configured = C.SUPABASE_URL && !C.SUPABASE_URL.includes('YOUR-PROJECT') && C.SUPABASE_ANON_KEY && !C.SUPABASE_ANON_KEY.includes('YOUR-ANON');
let sb = null;
let session = null;
let profile = null;
let actingMode = 'staff';
let route = 'home';
let moveTab = 'receive';
let reportTab = '';
let stockCache = [];
let scanLotsCache = [];
let scanLotsLoadedAt = 0;
let materialsCache = [];
let inventorySummaryCache = [];
let activityMaterialMap = null;
let usageMaterialCode = '';
let myStockTab = 'overview';
let scannerStream = null;
let scannerTimer = null;
let pendingIssueCode = new URLSearchParams(location.search).get('issue') || new URLSearchParams(location.search).get('lot');
let deferredInstallPrompt = null;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const page = $('#page');
const loginView = $('#loginView');
const appView = $('#appView');
const esc = (v = '') => String(v ?? '').replace(/[&<>'"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[m]));
const qty = v => Number(v || 0).toLocaleString('th-TH', {maximumFractionDigits: 2});
const d = v => v ? new Date(v + 'T00:00:00').toLocaleDateString('th-TH', {day:'2-digit',month:'2-digit',year:'numeric'}) : 'ไม่ระบุ';
const dt = v => v ? new Date(v).toLocaleString('th-TH', {dateStyle:'short',timeStyle:'short'}) : '-';
const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const isAdminAccount = () => profile?.role === 'admin';
const isAdminMode = () => isAdminAccount() && actingMode === 'admin';
const isMahidolEmail = email => /^[^@\s]+@mahidol\.ac\.th$/i.test(String(email || '').trim());


let responsiveTableQueued = false;
function enhanceResponsiveTables(root = document) {
  root.querySelectorAll?.('table.data-table').forEach(table => {
    const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(row => {
      [...row.children].forEach((cell, index) => {
        if (cell.tagName === 'TD' && !cell.hasAttribute('data-label')) {
          cell.setAttribute('data-label', headers[index] || '');
        }
      });
    });
    table.dataset.mobileCards = '1';
  });
}
function queueResponsiveTables(root = document) {
  if (responsiveTableQueued) return;
  responsiveTableQueued = true;
  requestAnimationFrame(() => {
    responsiveTableQueued = false;
    enhanceResponsiveTables(root);
  });
}

function normalizeMaterialSearch(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('th-TH').replace(/\s+/g, ' ').trim();
}

function materialComboboxMarkup({id, label = 'สินค้า', placeholder = 'พิมพ์ชื่อสินค้าบางส่วน', materials = [], initialCode = '', hint = ''}) {
  const selected = materials.find(m => m.code === initialCode);
  return `<label class="material-combo-label">${esc(label)}<div class="material-combobox" id="${esc(id)}Combo"><div class="material-combo-input-wrap">${icon('search')}<input id="${esc(id)}Search" class="material-combo-search" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(selected?.name || '')}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${esc(id)}Results"><button type="button" class="material-combo-clear ${selected ? '' : 'hidden'}" id="${esc(id)}Clear" aria-label="ล้างสินค้าที่เลือก">×</button></div><input type="hidden" id="${esc(id)}" value="${esc(selected?.code || '')}"><div class="material-combo-results hidden" id="${esc(id)}Results" role="listbox"></div></div>${hint ? `<small class="field-hint">${esc(hint)}</small>` : ''}</label>`;
}

function setupMaterialCombobox(id, materials, {onChange = null, maxResults = 12, ownerSelectId = ''} = {}) {
  const input = $(`#${id}Search`);
  const hidden = $(`#${id}`);
  const results = $(`#${id}Results`);
  const clearBtn = $(`#${id}Clear`);
  const ownerFilter = ownerSelectId ? $(`#${ownerSelectId}`) : null;
  if (!input || !hidden || !results || !clearBtn) return {clear(){}, select(){}};
  let activeIndex = -1;
  const normalized = materials.map(m => ({
    ...m,
    _name:normalizeMaterialSearch(m.name),
    _label:normalizeMaterialSearch(m.label_name),
    _code:normalizeMaterialSearch(m.code),
    _unit:normalizeMaterialSearch(m.unit),
    _owner:normalizeMaterialSearch(m.responsible_name || m.responsible_email)
  }));
  const close = () => { results.classList.add('hidden'); input.setAttribute('aria-expanded','false'); activeIndex = -1; };
  const setActive = index => {
    const options = [...results.querySelectorAll('[data-material-option]')];
    if (!options.length) return;
    activeIndex = Math.max(0, Math.min(index, options.length - 1));
    options.forEach((btn,i) => btn.classList.toggle('active', i === activeIndex));
    options[activeIndex]?.scrollIntoView({block:'nearest'});
  };
  const choose = (code, trigger = true) => {
    const item = materials.find(m => m.code === code);
    hidden.value = item?.code || '';
    input.value = item?.name || '';
    clearBtn.classList.toggle('hidden', !item);
    input.setCustomValidity('');
    close();
    if (trigger && onChange) onChange(hidden.value, item || null);
  };
  const render = () => {
    const q = normalizeMaterialSearch(input.value);
    const owner = ownerFilter?.value || '';
    hidden.value = '';
    clearBtn.classList.toggle('hidden', !input.value);
    let pool = normalized;
    if (owner) pool = pool.filter(m => m.responsible_email === owner);
    if (!q && !owner) {
      results.innerHTML = '<div class="material-combo-empty">พิมพ์ชื่อบางส่วน หรือเลือกผู้ดูแลก่อน</div>';
      results.classList.remove('hidden');
      input.setAttribute('aria-expanded','true');
      activeIndex = -1;
      return;
    }
    const ranked = pool.map(m => {
      let score = q ? 99 : 0;
      if (!q) score = 0;
      else if (m._name.startsWith(q)) score = 0;
      else if (m._name.includes(q)) score = 1;
      else if (m._label.startsWith(q)) score = 2;
      else if (m._label.includes(q)) score = 3;
      else if (m._code.includes(q)) score = 4;
      else if (m._owner.includes(q)) score = 5;
      else if (m._unit.includes(q)) score = 6;
      return {m,score};
    }).filter(x => x.score < 99).sort((a,b) => a.score - b.score || String(a.m.name).localeCompare(String(b.m.name),'th'));
    const shown = ranked.slice(0,maxResults);
    results.innerHTML = shown.map(({m}) => `<button type="button" data-material-option="${esc(m.code)}" role="option"><span>${esc(m.name)}</span><small>${esc(m.responsible_name || 'ยังไม่กำหนดผู้ดูแล')}${m.unit ? ` · ${esc(m.unit)}` : ''}</small></button>`).join('') + (ranked.length > maxResults ? `<div class="material-combo-more">พบอีก ${ranked.length-maxResults} รายการ พิมพ์เพิ่มเพื่อกรองให้แคบลง</div>` : '') || '<div class="material-combo-empty">ไม่พบสินค้า ลองพิมพ์คำอื่นหรือเปลี่ยนผู้ดูแล</div>';
    results.classList.remove('hidden');
    input.setAttribute('aria-expanded','true');
    activeIndex = -1;
  };
  input.addEventListener('focus', render);
  input.addEventListener('input', () => {
    input.setCustomValidity('');
    hidden.value = '';
    if (onChange) onChange('', null);
    render();
  });
  input.addEventListener('keydown', e => {
    const options = [...results.querySelectorAll('[data-material-option]')];
    if (e.key === 'ArrowDown') { e.preventDefault(); if (results.classList.contains('hidden')) render(); setActive(activeIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex <= 0 ? options.length - 1 : activeIndex - 1); }
    else if (e.key === 'Enter' && activeIndex >= 0 && options[activeIndex]) { e.preventDefault(); choose(options[activeIndex].dataset.materialOption); }
    else if (e.key === 'Escape') close();
  });
  results.addEventListener('mousedown', e => e.preventDefault());
  results.addEventListener('click', e => {
    const option = e.target.closest('[data-material-option]');
    if (option) choose(option.dataset.materialOption);
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  clearBtn.addEventListener('click', () => {
    hidden.value = '';
    input.value = '';
    clearBtn.classList.add('hidden');
    input.focus();
    render();
    if (onChange) onChange('', null);
  });
  ownerFilter?.addEventListener('change', () => {
    const selected = materials.find(m => m.code === hidden.value);
    if (selected && ownerFilter.value && selected.responsible_email !== ownerFilter.value) {
      hidden.value=''; input.value=''; clearBtn.classList.add('hidden');
      if (onChange) onChange('',null);
    }
    render();
  });
  return {
    clear(trigger = true) {
      hidden.value = '';
      input.value = '';
      clearBtn.classList.add('hidden');
      close();
      if (trigger && onChange) onChange('', null);
    },
    select(code, trigger = true) { choose(code, trigger); }
  };
}

let qrDecoderPromise = null;
function ensureQrDecoder() {
  if (typeof window.jsQR === 'function') return Promise.resolve(true);
  if (qrDecoderPromise) return qrDecoderPromise;
  qrDecoderPromise = new Promise(resolve => {
    const existing = document.querySelector('script[data-jsqr-loader]');
    if (existing) {
      existing.addEventListener('load', () => resolve(typeof window.jsQR === 'function'), {once:true});
      existing.addEventListener('error', () => resolve(false), {once:true});
      setTimeout(() => resolve(typeof window.jsQR === 'function'), 8000);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
    script.async = true;
    script.dataset.jsqrLoader = '1';
    script.onload = () => resolve(typeof window.jsQR === 'function');
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
    setTimeout(() => resolve(typeof window.jsQR === 'function'), 8000);
  });
  return qrDecoderPromise;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.background = bad ? '#b42318' : '#17201f';
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

function openModal(html) {
  stopScanner();
  $('#modalBody').innerHTML = html;
  queueResponsiveTables($('#modalBody'));
  $('#modal').classList.remove('hidden');
  $('#modal').setAttribute('aria-hidden', 'false');
}

function closeModal() {
  stopScanner();
  $('#modal').classList.add('hidden');
  $('#modal').setAttribute('aria-hidden', 'true');
  $('#modalBody').innerHTML = '';
}


function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isAndroidDevice() {
  return /android/i.test(navigator.userAgent);
}

function isStandaloneApp() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function refreshInstallUI() {
  const installed = isStandaloneApp();
  const status = installed
    ? 'ติดตั้งแอปในเครื่องนี้แล้ว'
    : isIosDevice()
      ? 'เครื่องนี้เป็น iPhone/iPad — ใช้ปุ่มติดตั้ง iOS'
      : isAndroidDevice()
        ? (deferredInstallPrompt ? 'พร้อมติดตั้งบน Android แล้ว' : 'เครื่องนี้เป็น Android — เปิดด้วย Chrome')
        : 'เลือกคู่มือตามอุปกรณ์ที่ต้องการติดตั้ง';
  $$('[data-install-status]').forEach(el => { el.textContent = status; });
  $$('[data-install-platform]').forEach(btn => {
    btn.classList.toggle('installed', installed);
    const label = btn.querySelector('[data-install-label]');
    if (!label) return;
    if (installed) label.textContent = 'ติดตั้งแล้ว';
    else if (btn.dataset.installPlatform === 'android') label.textContent = deferredInstallPrompt ? 'กดเพื่อติดตั้งทันที' : 'ผ่าน Chrome';
    else label.textContent = 'เปิดคู่มือ Safari';
  });
}

function initPwaInstall() {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    refreshInstallUI();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    refreshInstallUI();
    toast('ติดตั้ง CNMI Inventory สำเร็จแล้ว');
  });
  window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', refreshInstallUI);
  refreshInstallUI();
}

function openInstallChooser() {
  if (isStandaloneApp()) return toast('เครื่องนี้ติดตั้ง CNMI Inventory แล้ว');
  openModal(`<div class="install-modal-head"><span>${icon('smartphone')}</span><div><h3>ติดตั้ง CNMI Inventory</h3><p>เลือกตามอุปกรณ์ที่กำลังใช้งาน</p></div></div><div class="install-modal-grid"><button class="install-choice android" type="button" data-install-platform="android">${icon('download')}<span><strong>Android</strong><small>${deferredInstallPrompt ? 'พร้อมติดตั้งทันที' : 'Google Chrome'}</small></span></button><button class="install-choice ios" type="button" data-install-platform="ios">${icon('share')}<span><strong>iPhone / iPad</strong><small>Safari · เพิ่มไปยังหน้าจอโฮม</small></span></button></div><p class="install-security-note">ต้องเปิดผ่านโดเมน HTTPS ของระบบ จึงจะติดตั้งและใช้งานแบบ PWA ได้</p>`);
}

async function installAndroidApp() {
  if (isStandaloneApp()) return toast('เครื่องนี้ติดตั้ง CNMI Inventory แล้ว');
  if (deferredInstallPrompt) {
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      refreshInstallUI();
      if (choice?.outcome === 'accepted') toast('กำลังติดตั้ง CNMI Inventory');
      else toast('ยังไม่ได้ติดตั้ง สามารถกดปุ่มใหม่ภายหลังได้');
    } catch (e) {
      deferredInstallPrompt = promptEvent;
      refreshInstallUI();
      toast('เบราว์เซอร์ยังไม่อนุญาตให้ติดตั้งอัตโนมัติ', true);
    }
    return;
  }
  openModal(`<div class="install-modal-head"><span>${icon('download')}</span><div><h3>ติดตั้งบน Android</h3><p>กรณีปุ่มติดตั้งอัตโนมัติยังไม่ขึ้น ให้ทำตามขั้นตอนนี้</p></div></div><ol class="install-step-list"><li><b>เปิดเว็บด้วย Google Chrome</b><span>ไม่ใช้เบราว์เซอร์ใน LINE, Facebook หรือแอปแชต</span></li><li><b>แตะเมนูจุดสามจุด ⋮</b><span>อยู่มุมขวาบนของ Chrome</span></li><li><b>เลือก “ติดตั้งแอป”</b><span>บางเครื่องจะแสดงว่า “เพิ่มไปยังหน้าจอหลัก”</span></li><li><b>แตะ “ติดตั้ง”</b><span>ไอคอน CNMI Inventory จะอยู่บนหน้าจอแอป</span></li></ol><button class="primary wide-action" type="button" data-modal-close>เข้าใจแล้ว</button>`);
}

function showIosInstallGuide() {
  if (isStandaloneApp()) return toast('เครื่องนี้ติดตั้ง CNMI Inventory แล้ว');
  openModal(`<div class="install-modal-head"><span>${icon('share')}</span><div><h3>ติดตั้งบน iPhone / iPad</h3><p>iOS ไม่อนุญาตให้เว็บไซต์กดติดตั้งแทนผู้ใช้ จึงต้องเพิ่มผ่าน Safari</p></div></div><ol class="install-step-list ios-steps"><li><b>เปิดเว็บนี้ด้วย Safari</b><span>หากเปิดจาก LINE ให้เลือก “เปิดใน Safari” ก่อน</span></li><li><b>แตะปุ่มแชร์</b><span>สัญลักษณ์สี่เหลี่ยมมีลูกศรชี้ขึ้น</span></li><li><b>เลื่อนแล้วเลือก “เพิ่มไปยังหน้าจอโฮม”</b><span>ชื่อเมนูภาษาอังกฤษคือ Add to Home Screen</span></li><li><b>แตะ “เพิ่ม”</b><span>ไอคอน CNMI Inventory จะปรากฏบนหน้าจอโฮม</span></li></ol><div class="install-ios-note"><b>กรณีไม่พบเมนู</b><span>แตะ “แก้ไขการทำงาน” แล้วเพิ่มคำสั่ง “เพิ่มไปยังหน้าจอโฮม”</span></div><button class="primary wide-action" type="button" data-modal-close>เข้าใจแล้ว</button>`);
}


function openMobileMenu() {
  const adminItem = isAdminMode() ? `<button type="button" data-route="admin">${icon('settings')}<span><strong>ตั้งค่าระบบ</strong><small>ผู้ใช้ ผู้ดูแล และข้อมูลสินค้า</small></span></button>` : '';
  openModal(`<div class="mobile-menu-sheet"><div class="mobile-menu-head"><span class="owner-avatar">${esc((profile?.display_name || '?').trim().charAt(0))}</span><div><h3>เมนูทั้งหมด</h3><p>${esc(profile?.display_name || '')}</p></div></div><div class="mobile-menu-grid"><button type="button" data-route="stock">${icon('box')}<span><strong>ค้นหาสต๊อกทั้งหมด</strong><small>ค้นหาสินค้าและ Lot</small></span></button><button type="button" data-route="my-stock">${icon('user')}<span><strong>สต๊อกที่ฉันดูแล</strong><small>ดูของที่มี ต้องเบิก และตั้งค่าการเตือน</small></span></button><button type="button" data-route="usage">${icon('chart')}<span><strong>วิเคราะห์การใช้</strong><small>การใช้และแนวโน้มหมดอายุ</small></span></button><button type="button" data-route="weekly">${icon('check')}<span><strong>ตรวจวันศุกร์</strong><small>ตรวจนับและปรับยอดจริง</small></span></button><button type="button" data-route="scan-stock">${icon('camera')}<span><strong>สแกนตรวจ Lot</strong><small>ดูยอดคงเหลือและตรวจด้วยกล้อง</small></span></button><button type="button" data-route="weekly-status">${icon('user')}<span><strong>สถานะผู้ตรวจ</strong><small>ดูย้อนหลังตามช่วงวันที่</small></span></button><button type="button" data-route="activity">${icon('history')}<span><strong>ประวัติ</strong><small>รายการที่ทำในระบบ</small></span></button><button type="button" data-route="reports">${icon('download')}<span><strong>รายงานและส่งออก</strong><small>CSV และข้อมูลย้อนหลัง</small></span></button>${adminItem}<button type="button" data-route="help">${icon('help')}<span><strong>คู่มือใช้งาน</strong><small>ขั้นตอนทำงาน</small></span></button><button type="button" data-open-install>${icon('smartphone')}<span><strong>ติดตั้งแอป</strong><small>Android และ iPhone/iPad</small></span></button></div></div>`);
}

function loading() {
  page.innerHTML = '<div class="grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
}

function clearDataCaches() {
  stockCache = []; scanLotsCache=[]; scanLotsLoadedAt=0;
  materialsCache = [];
  inventorySummaryCache = [];
}

async function refreshCurrentData(button = null) {
  const original = button?.innerHTML || '';
  if (button) {
    button.disabled = true;
    button.classList.add('is-refreshing');
    button.innerHTML = `${icon('refresh')} กำลังรีเฟรช`;
  }
  try {
    clearDataCaches();
    await navigate(route, {tab:moveTab, material:usageMaterialCode, force:true});
    toast('รีเฟรชข้อมูลล่าสุดแล้ว');
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.classList.remove('is-refreshing');
      button.innerHTML = original;
    }
  }
}

function errMsg(e) {
  return e?.message || String(e || 'เกิดข้อผิดพลาด');
}

function todayStart() {
  const x = new Date();
  x.setHours(0, 0, 0, 0);
  return x;
}

function todayIso() {
  const x = todayStart();
  return x.toISOString();
}

function isExpired(x) {
  return Boolean(x?.is_expired || (x?.expiry_date && new Date(x.expiry_date + 'T00:00:00') < todayStart()));
}

function requiresExpiryConfirmation(x) {
  return Boolean(isExpired(x) && x?.expiry_date && String(x.expiry_date) >= EXPIRY_REVIEW_START);
}

function lotKey(l) {
  return l?.lot_key || `${l?.material_code || l?.stock_code || ''}-${l?.lot_no || ''}`;
}

function pgArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    return value.slice(1, -1).split(',').map(x => x.replace(/^"|"$/g, '')).filter(Boolean);
  }
  return [];
}

function updateUrgentBadge(count) {
  const badge = $('#urgentBadge');
  if (!badge) return;
  badge.textContent = count > 99 ? '99+' : String(count || 0);
  badge.classList.toggle('hidden', !count);
}

function updateRoleUI() {
  const adminAccount = isAdminAccount();
  const adminMode = isAdminMode();
  $$('.admin-account-only').forEach(el => el.classList.toggle('hidden', !adminAccount));
  $$('.admin-only').forEach(el => el.classList.toggle('hidden', !adminMode));
  $$('[data-role-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.roleMode === actingMode));
  document.body.classList.toggle('is-admin', adminMode);
  document.body.classList.toggle('admin-account', adminAccount);
  const modeText = adminAccount ? (adminMode ? 'โหมดผู้ดูแลระบบ' : 'โหมดเจ้าหน้าที่') : 'เจ้าหน้าที่';
  if ($('#userBadge')) $('#userBadge').textContent = `${profile?.display_name || ''} · ${modeText}`;
  if ($('#roleModeLabel')) $('#roleModeLabel').textContent = modeText;
}

async function switchActingMode(mode) {
  if (!isAdminAccount()) return;
  actingMode = mode === 'admin' ? 'admin' : 'staff';
  localStorage.setItem(`cnmi-inventory-mode:${profile.email}`, actingMode);
  updateRoleUI();
  if (!isAdminMode() && route === 'admin') await navigate('home');
  else await navigate(route === 'admin' ? 'admin' : route);
}

async function init() {
  initPwaInstall();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if ($('#staffPlannerLink') && C.STAFF_PLANNER_URL) $('#staffPlannerLink').href = C.STAFF_PLANNER_URL;

  $('#modal').addEventListener('click', e => {
    if (e.target.id === 'modal' || e.target.closest('.modal-close')) closeModal();
  });
  $('#loginForm').addEventListener('submit', login);
  $('#registerBtn').addEventListener('click', register);
  $('#logoutBtn').addEventListener('click', logout);
  document.addEventListener('click', globalClick);
  const tableObserver = new MutationObserver(() => queueResponsiveTables(document));
  tableObserver.observe(page, {childList:true, subtree:true});
  tableObserver.observe($('#modalBody'), {childList:true, subtree:true});
  window.addEventListener('beforeunload', stopScanner);

  if (!configured) {
    $('#setupWarning').classList.remove('hidden');
    $('#setupWarning').textContent = 'ยังไม่ได้ตั้งค่า Supabase กรุณาแก้ไฟล์ assets/config.js ตาม README_INSTALL_TH.md';
    return;
  }

  sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, {
    auth: {persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}
  });
  const {data} = await sb.auth.getSession();
  session = data.session;
  sb.auth.onAuthStateChange((_event, s) => {
    session = s;
    if (!s) showLogin();
  });
  if (session) await enterApp();
}

async function login(e) {
  e.preventDefault();
  if (!configured) return toast('กรุณาตั้งค่า Supabase ก่อน', true);
  const email = $('#loginEmail').value.trim().toLowerCase();
  const password = $('#loginPassword').value;
  if (!isMahidolEmail(email)) return toast('ใช้ได้เฉพาะอีเมลมหิดล @mahidol.ac.th', true);
  const btn = e.submitter;
  btn.disabled = true;
  const {error} = await sb.auth.signInWithPassword({email, password});
  btn.disabled = false;
  if (error) return toast(errMsg(error), true);
  await enterApp();
}

async function register() {
  if (!configured) return toast('กรุณาตั้งค่า Supabase ก่อน', true);
  const email = $('#loginEmail').value.trim().toLowerCase();
  const password = $('#loginPassword').value;
  if (!isMahidolEmail(email)) return toast('ใช้ได้เฉพาะอีเมลมหิดล @mahidol.ac.th', true);
  if (password.length < 6) return toast('ตั้งรหัสผ่านสำหรับแอปอย่างน้อย 6 ตัว', true);
  const {data,error} = await sb.auth.signUp({email, password});
  if (error) {
    const msg=String(error.message || '');
    if (/database error|saving new user/i.test(msg)) return toast('อีเมลนี้อาจยังไม่ได้รับสิทธิ์จาก Admin หรือไม่ใช่อีเมลมหิดล', true);
    return toast(errMsg(error), true);
  }
  if (data?.session) await sb.auth.signOut();
  toast('สร้างบัญชีแล้ว กดเข้าสู่ระบบด้วยอีเมลและรหัสเดิม');
}

async function loadProfile() {
  const {data, error} = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error) throw error;
  if (!data || !data.active) throw new Error('อีเมลนี้ยังไม่ได้รับสิทธิ์ใช้งาน');
  profile = data;
}

async function enterApp() {
  try {
    const {data} = await sb.auth.getSession();
    session = data.session;
    if (!session) return showLogin();
    await loadProfile();
    actingMode = isAdminAccount() ? (localStorage.getItem(`cnmi-inventory-mode:${profile.email}`) || 'staff') : 'staff';
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    updateRoleUI();
    const hashRoute = location.hash.replace(/^#/, '');
    const allowed = ['home','stock','my-stock','usage','urgent','move','weekly','scan-stock','weekly-status','activity','reports','help','admin'];
    const initialRoute = allowed.includes(hashRoute) ? hashRoute : 'home';
    await navigate(initialRoute);
    if (pendingIssueCode) setTimeout(openPendingIssue, 250);
  } catch (e) {
    toast(errMsg(e), true);
    await sb.auth.signOut();
    showLogin();
  }
}

function showLogin() {
  stopScanner();
  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
}

async function logout() {
  if (sb) await sb.auth.signOut();
  profile = null;
  stockCache = []; scanLotsCache=[]; scanLotsLoadedAt=0;
  materialsCache = [];
  inventorySummaryCache = [];
  usageMaterialCode = '';
  showLogin();
}

function globalClick(e) {
  const modalCloseBtn = e.target.closest('[data-modal-close]');
  if (modalCloseBtn) {
    e.preventDefault();
    closeModal();
    return;
  }
  const openInstall = e.target.closest('[data-open-install]');
  if (openInstall) {
    e.preventDefault();
    openInstallChooser();
    return;
  }
  const installBtn = e.target.closest('[data-install-platform]');
  if (installBtn) {
    e.preventDefault();
    if (installBtn.dataset.installPlatform === 'android') installAndroidApp();
    else showIosInstallGuide();
    return;
  }
  const mobileMenu = e.target.closest('[data-mobile-menu]');
  if (mobileMenu) {
    e.preventDefault();
    openMobileMenu();
    return;
  }
  const roleBtn = e.target.closest('[data-role-mode]');
  if (roleBtn) {
    e.preventDefault();
    switchActingMode(roleBtn.dataset.roleMode);
    return;
  }
  const ownerDetail = e.target.closest('[data-owner-detail]');
  if (ownerDetail) {
    e.preventDefault();
    openOwnerDetail(ownerDetail.dataset.ownerDetail);
    return;
  }
  const materialDetail = e.target.closest('[data-material-detail]');
  if (materialDetail) {
    e.preventDefault();
    openMaterialStockDetail(materialDetail.dataset.materialDetail);
    return;
  }
  const materialUsage = e.target.closest('[data-material-usage]');
  if (materialUsage) {
    e.preventDefault();
    if (!$('#modal').classList.contains('hidden')) closeModal();
    navigate('usage', {material:materialUsage.dataset.materialUsage});
    return;
  }
  const r = e.target.closest('[data-route]');
  if (r) {
    e.preventDefault();
    if (!$('#modal').classList.contains('hidden')) closeModal();
    navigate(r.dataset.route, {tab:r.dataset.moveTab, filter:r.dataset.stockFilter});
    return;
  }
  const p = e.target.closest('[data-print]');
  if (p) {
    e.preventDefault();
    printLabel(p.dataset.print);
    return;
  }
  const issue = e.target.closest('[data-issue-lot]');
  if (issue) {
    e.preventDefault();
    const l = stockCache.find(x => x.lot_id === issue.dataset.issueLot);
    if (l) openIssueModal(l, 'manual');
    return;
  }
  const scan = e.target.closest('[data-camera-scan]');
  if (scan) {
    e.preventDefault();
    startCameraScanner(scan.dataset.scanMode || 'issue');
    return;
  }
  const scanConfirm = e.target.closest('[data-scan-confirm-check]');
  if (scanConfirm) {
    e.preventDefault();
    confirmScannedCheck(scanConfirm.dataset.scanConfirmCheck);
    return;
  }
  const scanAgain = e.target.closest('[data-scan-again]');
  if (scanAgain) {
    e.preventDefault();
    closeModal();
    startCameraScanner('inspect');
    return;
  }
  const c = e.target.closest('[data-check]');
  if (c) {
    e.preventDefault();
    openCheck(c.dataset.check);
    return;
  }
  const ex = e.target.closest('[data-expired-remove]');
  if (ex) {
    e.preventDefault();
    openExpiredRemoval(ex.dataset.expiredRemove);
    return;
  }
  const edit = e.target.closest('[data-edit-material]');
  if (edit) {
    e.preventDefault();
    openMaterialEditor(edit.dataset.editMaterial);
    return;
  }
  const exp = e.target.closest('[data-export-report]');
  if (exp) {
    e.preventDefault();
    exportReport(exp.dataset.exportReport);
  }
}

function navActive() {
  $$('.bottom-nav button, .side-nav button').forEach(b => {
    if (b.hasAttribute('data-mobile-menu')) {
      b.classList.toggle('active', !['home','move','urgent'].includes(route));
      return;
    }
    const sameRoute = b.dataset.route === route;
    const active = sameRoute && (route !== 'move' ? true : ((b.dataset.moveTab || '') === moveTab || !b.dataset.moveTab));
    b.classList.toggle('active', active);
  });
}

async function navigate(r, options = {}) {
  if (r === 'admin' && !isAdminMode()) {
    r = 'home';
    toast('สลับเป็นโหมดผู้ดูแลระบบก่อนเข้าหน้าตั้งค่า', true);
  }
  route = r;
  if (r === 'move') moveTab = options.tab || moveTab || 'receive';
  if (r === 'usage') usageMaterialCode = options.material || usageMaterialCode || '';
  if (r === 'my-stock') myStockTab = options.tab || myStockTab || 'overview';
  navActive();
  loading();
  try {
    if (r === 'home') await renderHome();
    else if (r === 'stock') await renderStock(options.filter || 'select');
    else if (r === 'my-stock') await renderMyStock(options.tab || myStockTab);
    else if (r === 'usage') await renderUsage(usageMaterialCode);
    else if (r === 'urgent') await renderUrgent();
    else if (r === 'move') await renderMove(moveTab);
    else if (r === 'weekly') await renderWeekly();
    else if (r === 'scan-stock') await renderScanStock();
    else if (r === 'weekly-status') await renderWeeklyStatus();
    else if (r === 'activity') await renderActivity();
    else if (r === 'reports') await renderReports(reportTab);
    else if (r === 'help') renderHelp();
    else if (r === 'admin') await renderAdmin();
    else await renderHome();
    queueResponsiveTables(page);
    try { history.replaceState({}, '', `${location.pathname}${location.search}#${r}`); } catch (_) {}
    window.scrollTo({top:0, behavior:'smooth'});
  } catch (e) {
    page.innerHTML = `<div class="card notice">${esc(errMsg(e))}</div>`;
  }
}

async function getLots(force = false) {
  if (!force && stockCache.length) return stockCache;
  const {data, error} = await sb.from('v_lot_balances').select('*').eq('active', true).order('material_code').order('lot_no');
  if (error) throw error;
  stockCache = (data || []).filter(x => Number(x.balance) !== 0);
  return stockCache;
}

async function ensureCheck() {
  const {data, error} = await sb.rpc('fn_ensure_weekly_check');
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

function statusBadge(x) {
  if (isExpired(x) && Number(x.balance) > 0) return '<span class="badge danger">หมดอายุ · รอนำออก</span>';
  if (Number(x.balance) < 0) return '<span class="badge danger">ยอดติดลบ</span>';
  if (Number(x.balance) <= 0) return '<span class="badge danger">หมด</span>';
  if (Number(x.balance) < Number(x.min_qty)) return '<span class="badge warn">ต่ำกว่าขั้นต่ำ</span>';
  if (x.days_to_expiry !== null && Number(x.days_to_expiry) <= 30) return '<span class="badge warn">ใกล้หมดอายุ</span>';
  return '<span class="badge ok">คงเหลือ</span>';
}

function ownerOptions(staff = [], selected = '') {
  return [`<option value="">ยังไม่กำหนด</option>`].concat((staff || []).map(s => `<option value="${esc(s.email)}" ${s.email === selected ? 'selected' : ''}>${esc(s.display_name)}${s.role === 'admin' ? ' (Admin)' : ''}</option>`)).join('');
}

function groupByOwner(summaryRows = []) {
  const map = new Map();
  summaryRows.forEach(row => {
    const key = row.responsible_email || 'unassigned';
    if (!map.has(key)) map.set(key, {
      responsible_email: row.responsible_email || '',
      responsible_name: row.responsible_name || 'ยังไม่กำหนด',
      materials: 0,
      low_count: 0,
      out_count: 0,
      expired_count: 0
    });
    const item = map.get(key);
    item.materials += 1;
    if (row.needs_reorder) {
      if ((row.alert_mode || 'MINIMUM') === 'MINIMUM' && Number(row.total_balance || 0) <= 0) item.out_count += 1;
      else item.low_count += 1;
    }
    item.expired_count += Number(row.expired_pending_lots || 0);
  });
  return [...map.values()].sort((a,b) => (b.expired_count + b.out_count + b.low_count) - (a.expired_count + a.out_count + a.low_count) || a.responsible_name.localeCompare(b.responsible_name, 'th'));
}

function seedActivityMaterialMap(rows = []) {
  if (!activityMaterialMap) activityMaterialMap = new Map();
  rows.forEach(row => {
    const info = {
      name: row.material_name || row.name || row.label_name || '',
      unit: row.unit || '',
      code: row.material_code || row.code || row.stock_code || ''
    };
    [row.material_code, row.code, row.stock_code].filter(Boolean).forEach(key => {
      const norm = String(key).trim().toUpperCase();
      const existing = activityMaterialMap.get(norm);
      if (!existing || (!existing.name && info.name)) activityMaterialMap.set(norm, info);
    });
  });
}

async function loadActivityMaterials() {
  if (activityMaterialMap?.size) return activityMaterialMap;
  const {data, error} = await sb.from('materials').select('code,stock_code,name,label_name,unit,is_main,status').order('is_main', {ascending:false});
  if (error) throw error;
  seedActivityMaterialMap(data || []);
  return activityMaterialMap;
}

function activityMaterialInfo(detail = {}) {
  const code = detail.material_code || detail.stock_code || '';
  const key = String(code).trim().toUpperCase();
  const mapped = activityMaterialMap?.get(key) || {};
  return {
    code,
    name: detail.material_name || detail.name || mapped.name || '',
    unit: detail.unit || mapped.unit || ''
  };
}

function normalizeIssueMethod(value) {
  const method = String(value || '').trim().toUpperCase();
  return method === 'QR_SCAN' ? 'QR_SCAN' : method === 'MANUAL_ENTRY' ? 'MANUAL_ENTRY' : '';
}

function issueMethodLabel(value) {
  const method = normalizeIssueMethod(value);
  if (method === 'QR_SCAN') return 'สแกน QR';
  if (method === 'MANUAL_ENTRY') return 'พิมพ์รหัสเอง';
  return 'ไม่ระบุ — ข้อมูลเดิม';
}

function issueMethodBadge(value) {
  const method = normalizeIssueMethod(value);
  const cls = method === 'QR_SCAN' ? 'ok' : method === 'MANUAL_ENTRY' ? 'info' : '';
  return `<span class="badge ${cls}">${esc(issueMethodLabel(value))}</span>`;
}

function activityCard(a) {
  const detail = a.summary || {};
  const info = activityMaterialInfo(detail);
  const actionText = a.action_label || a.action || 'ทำรายการ';
  const title = info.name ? `${actionText} · ${info.name}` : actionText;
  const detailParts = [];
  if (detail.lot_no) detailParts.push(`Lot ${detail.lot_no}`);
  if (a.action === 'ISSUE') detailParts.push(`วิธีนำออก: ${issueMethodLabel(detail.issue_method)}`);
  if (detail.before !== undefined && detail.after !== undefined) {
    detailParts.push(`คงเหลือ ${qty(detail.before)} → ${qty(detail.after)}${info.unit ? ' ' + info.unit : ''}`);
  } else if (detail.quantity !== undefined) {
    detailParts.push(`จำนวน ${qty(detail.quantity)}${info.unit ? ' ' + info.unit : ''}`);
  }
  const metaParts = [];
  if (info.code) metaParts.push(`รหัส ${info.code}`);
  metaParts.push(`โดย ${a.actor_name || a.actor_email || 'SYSTEM'}`);
  metaParts.push(dt(a.created_at));
  const iconName = a.action === 'RECEIVE' ? 'plus' : a.action === 'ISSUE' ? 'minus' : a.action === 'LABEL_PRINT' ? 'print' : 'check';
  return `<div class="activity-row"><span class="activity-dot">${icon(iconName)}</span><div class="activity-copy"><strong class="activity-title">${esc(title)}</strong>${detailParts.length ? `<div class="activity-detail">${detailParts.map(esc).join(' · ')}</div>` : ''}<div class="activity-meta">${metaParts.map(esc).join(' · ')}</div></div></div>`;
}

async function renderHome() {
  const [summaryRes, checkRes, activityRes, todayTxRes, nearRes] = await Promise.all([
    sb.from('v_inventory_summary').select('*').order('material_code'),
    ensureCheck(),
    sb.from('v_audit_activity').select('*').limit(12),
    sb.from('v_transaction_history').select('id,tx_type,created_at').gte('created_at', todayIso()).limit(600),
    sb.from('v_lot_balances').select('lot_id,days_to_expiry').eq('active', true).eq('is_expired', false).gt('balance', 0).gte('days_to_expiry', 0).lte('days_to_expiry', 30)
  ]);
  if (summaryRes.error) throw summaryRes.error;
  if (activityRes.error) throw activityRes.error;
  if (todayTxRes.error) throw todayTxRes.error;
  if (nearRes.error) throw nearRes.error;

  const summaries = summaryRes.data || [];
  inventorySummaryCache = summaries;
  seedActivityMaterialMap(summaries);
  const activities = activityRes.data || [];
  const todayTx = todayTxRes.data || [];
  const expiredPendingCount = summaries.reduce((sum,x) => sum + Number(x.expired_pending_lots || 0), 0);
  const reorderMaterials = summaries.filter(x => Boolean(x.needs_reorder));
  const outMaterials = summaries.filter(x => Boolean(x.needs_reorder) && (x.alert_mode || 'MINIMUM') === 'MINIMUM' && Number(x.total_balance || 0) <= 0);
  const lowMaterials = summaries.filter(x => Boolean(x.needs_reorder) && (x.alert_mode || 'MINIMUM') === 'MINIMUM' && Number(x.total_balance || 0) > 0);
  const nearExpiryCount = (nearRes.data || []).length;
  const receiveToday = todayTx.filter(x => x.tx_type === 'RECEIVE').length;
  const issueToday = todayTx.filter(x => x.tx_type === 'ISSUE').length;
  const watchRows = summaries.filter(x => Boolean(x.needs_reorder));
  const ownerGroups = groupByOwner(watchRows);
  updateUrgentBadge(expiredPendingCount + reorderMaterials.length);

  let prog = null;
  if (checkRes) {
    const q = await sb.from('v_weekly_check_progress').select('*').eq('check_id', checkRes.id).maybeSingle();
    prog = q.data;
  }

  const productRows = [...watchRows].sort((a, b) => {
    const score = x => (x.alert_mode || 'MINIMUM') === 'MONTHLY' ? 3 : Number(x.total_balance || 0) <= 0 ? 2 : 1;
    return score(b) - score(a) || Number(a.total_balance || 0) - Number(b.total_balance || 0) || String(a.material_name || '').localeCompare(String(b.material_name || ''), 'th');
  });

  page.innerHTML = `
    <div class="page-head dashboard-head"><div><h2>หน้าหลัก</h2><p class="muted small">ภาพรวมสถานะสต๊อก วันนี้ ${new Date().toLocaleDateString('th-TH',{day:'numeric',month:'long',year:'numeric'})}</p></div><button class="mini ghost" id="refreshHome">${icon('refresh')} รีเฟรช</button></div>

    <section class="home-workflow" aria-label="งานที่ใช้บ่อย"><button data-route="move" data-move-tab="receive">${icon('plus')}<span><strong>รับเข้า</strong></span></button><button data-route="move" data-move-tab="issue">${icon('minus')}<span><strong>นำออก</strong></span></button><button data-route="scan-stock">${icon('camera')}<span><strong>สแกนตรวจ Lot</strong></span></button><button data-route="weekly">${icon('check')}<span><strong>ตรวจวันศุกร์</strong></span></button><button data-route="my-stock">${icon('user')}<span><strong>สต๊อกที่ฉันดูแล</strong></span></button></section>

    <div class="grid kpi-grid kpi-grid-6">
      <button class="card kpi kpi-button" data-route="urgent"><div class="kpi-top"><span class="kpi-icon danger">${icon('box')}</span><small>ต้องเบิก</small></div><strong>${reorderMaterials.length}</strong><small>รายการ</small></button>
      <button class="card kpi kpi-button" data-route="stock" data-stock-filter="low"><div class="kpi-top"><span class="kpi-icon warn">${icon('alert')}</span><small>ต่ำกว่าขั้นต่ำ</small></div><strong>${lowMaterials.length}</strong><small>รายการ</small></button>
      <button class="card kpi kpi-button" data-route="move" data-move-tab="receive"><div class="kpi-top"><span class="kpi-icon">${icon('plus')}</span><small>นำเข้า (วันนี้)</small></div><strong>${receiveToday}</strong><small>รายการ</small></button>
      <button class="card kpi kpi-button" data-route="move" data-move-tab="issue"><div class="kpi-top"><span class="kpi-icon info">${icon('minus')}</span><small>นำออก (วันนี้)</small></div><strong>${issueToday}</strong><small>รายการ</small></button>
      <button class="card kpi kpi-button" data-route="urgent"><div class="kpi-top"><span class="kpi-icon danger">${icon('history')}</span><small>หมดอายุ · รอนำออก</small></div><strong>${expiredPendingCount}</strong><small>Lot</small></button>
      <button class="card kpi kpi-button" data-route="stock" data-stock-filter="expiry"><div class="kpi-top"><span class="kpi-icon warn">${icon('calendar')}</span><small>ใกล้หมดอายุ (≤ 30 วัน)</small></div><strong>${nearExpiryCount}</strong><small>Lot</small></button>
    </div>

    <div class="overview-grid">
      <section class="card table-card">
        <div class="section-title compact"><div><h3>สินค้าที่ต้องเฝ้าระวัง</h3></div><div class="segmented"><button id="homeModeProduct" class="seg active" type="button">ดูตามสินค้า</button><button id="homeModeOwner" class="seg" type="button">ดูตามผู้ดูแล</button></div></div>
        <div id="homeOverviewPane"></div>
      </section>
      <section class="card activity-panel">
        <div class="section-title compact"><div><h3>กิจกรรมล่าสุด</h3></div><button class="mini ghost" data-route="activity">ดูทั้งหมด ${icon('arrow')}</button></div>
        <div class="activity-list">${activities.slice(0, 6).map(activityCard).join('') || '<div class="empty">ยังไม่มีกิจกรรม</div>'}</div>
      </section>
    </div>

    ${prog ? `<section class="card weekly-summary"><div class="weekly-ring" style="--pct:${Number(prog.percent_complete || 0)}"><div><strong>${prog.checked_items}/${prog.total_items}</strong><span>${prog.percent_complete}%</span></div></div><div><h3>ตรวจสต๊อกวันศุกร์ ${d(prog.week_friday)}</h3><p class="muted">${prog.status === 'COMPLETED' ? 'ปิดรอบแล้ว' : `ยังเหลือ ${prog.pending_items ?? (prog.total_items-prog.checked_items)} Lot`}</p><button class="mini" data-route="weekly">ดูรายการตรวจทั้งหมด ${icon('arrow')}</button></div></section>` : ''}
  `;

  const HOME_PAGE_SIZE = 7;
  let homeProductPage = 1;
  let homeMode = 'product';
  const ownerHtml = `<div class="owner-summary-grid">${ownerGroups.map(g => `<button class="owner-box owner-box-button" type="button" data-owner-detail="${esc(g.responsible_email || 'unassigned')}"><span class="owner-avatar">${esc((g.responsible_name || '?').trim().charAt(0))}</span><span class="owner-box-copy"><strong>${esc(g.responsible_name)}</strong><small>${esc(g.responsible_email || 'ยังไม่กำหนด')}</small><span class="owner-stats"><span>ต้องเบิก ${g.materials} รายการ</span><span>ต่ำกว่าขั้นต่ำ/ถึงรอบ ${g.low_count}</span><span>สินค้าหมด ${g.out_count}</span></span><em>กดเพื่อดูรายการที่ดูแล ${icon('arrow')}</em></span></button>`).join('') || '<div class="empty">ไม่มีสินค้าที่ต้องเฝ้าระวัง</div>'}</div>`;
  const pane = $('#homeOverviewPane');
  const productTable = rows => `<div class="table-wrap quiet-table"><table class="data-table"><thead><tr><th>รายการสินค้า</th><th>คงเหลือ</th><th>ขั้นต่ำ</th><th>ผู้ดูแล</th><th>สถานะ</th><th></th></tr></thead><tbody>${rows.map(x => `<tr><td><button class="table-name-link" data-material-detail="${esc(x.material_code)}"><span>${esc(x.material_name)}</span></button></td><td><span class="table-number">${qty(x.total_balance)}</span> ${esc(x.unit)}</td><td>${qty(x.min_qty)}</td><td><button class="owner-inline-link" data-owner-detail="${esc(x.responsible_email || 'unassigned')}">${esc(x.responsible_name || 'ยังไม่กำหนด')}</button></td><td><span class="badge warn">${x.alert_mode==='MONTHLY'?'ถึงรอบเบิก':Number(x.total_balance||0)<=0?'หมด':'ต่ำกว่าขั้นต่ำ'}</span></td><td><button class="icon-mini" title="วิเคราะห์การใช้" data-material-usage="${esc(x.material_code)}">${icon('chart')}</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">ไม่มีสินค้าที่ต้องเบิกหรือต่ำกว่าขั้นต่ำ</td></tr>'}</tbody></table></div>`;
  const renderProductPage = () => {
    const pageCount = Math.max(1, Math.ceil(productRows.length / HOME_PAGE_SIZE));
    homeProductPage = Math.min(Math.max(1, homeProductPage), pageCount);
    const begin = (homeProductPage - 1) * HOME_PAGE_SIZE;
    const rows = productRows.slice(begin, begin + HOME_PAGE_SIZE);
    const pagination = productRows.length > HOME_PAGE_SIZE ? `<div class="home-pagination"><span>หน้า ${homeProductPage} / ${pageCount} · ทั้งหมด ${productRows.length} รายการ</span><div><button type="button" class="mini ghost" data-home-page="prev" ${homeProductPage===1?'disabled':''}>ก่อนหน้า</button><button type="button" class="mini" data-home-page="next" ${homeProductPage===pageCount?'disabled':''}>หน้าถัดไป</button></div></div>` : (productRows.length ? `<div class="home-pagination single"><span>ทั้งหมด ${productRows.length} รายการ</span></div>` : '');
    pane.innerHTML = productTable(rows) + pagination;
    queueResponsiveTables(pane);
    $$('[data-home-page]', pane).forEach(btn => btn.addEventListener('click', () => { homeProductPage += btn.dataset.homePage === 'next' ? 1 : -1; renderProductPage(); }));
  };
  const setMode = mode => {
    homeMode = mode;
    $('#homeModeProduct').classList.toggle('active', mode === 'product');
    $('#homeModeOwner').classList.toggle('active', mode === 'owner');
    if (mode === 'owner') pane.innerHTML = ownerHtml;
    else { homeProductPage = 1; renderProductPage(); }
  };
  $('#homeModeProduct').onclick = () => setMode('product');
  $('#homeModeOwner').onclick = () => setMode('owner');
  $('#refreshHome').onclick = e => refreshCurrentData(e.currentTarget);
  setMode('product');
}

function lotCard(l) {
  const aliases = pgArray(l.legacy_lot_keys);
  return `<div class="card lot-card ${isExpired(l) ? 'expired-card' : ''}"><div class="lot-main"><div class="lot-code">${icon('qr')} ${esc(lotKey(l))}</div><div class="lot-title">${esc(l.material_name)}</div><div class="lot-meta">Lot ${esc(l.lot_no)} · EXP ${d(l.expiry_date)}</div><div class="lot-meta">ผู้ดูแล: ${esc(l.responsible_name || '-')}</div>${aliases.length ? `<div class="legacy-note">สติ๊กเกอร์รหัสเดิมยังใช้ได้: ${aliases.map(esc).join(', ')}</div>` : ''}<div style="margin-top:8px">${statusBadge(l)}</div><div class="actions">${!isExpired(l) ? `<button class="mini" data-print="${esc(l.lot_id)}">${icon('print')} พิมพ์ QR</button>${Number(l.balance) > 0 ? `<button class="mini ghost" data-issue-lot="${esc(l.lot_id)}">${icon('minus')} นำออก</button>` : ''}` : `<button class="mini danger" data-route="weekly">${icon('check')} ยืนยันนำออกในตรวจวันศุกร์</button>`}</div></div><div class="qty-wrap"><div class="qty">${qty(l.balance)}</div><div class="muted small">${esc(l.unit)}</div></div></div>`;
}

function lotTableRows(lots) {
  return lots.map(l => `<tr class="${isExpired(l) ? 'expired-row' : ''}"><td><span class="code-pill">${esc(lotKey(l))}</span></td><td><span class="table-number">${qty(l.balance)}</span> ${esc(l.unit)}</td><td>${d(l.expiry_date)}</td><td>${statusBadge(l)}</td><td><div class="row-actions">${!isExpired(l) ? `<button class="icon-mini" title="พิมพ์ QR" data-print="${esc(l.lot_id)}">${icon('print')}</button><button class="icon-mini" title="นำออก" data-issue-lot="${esc(l.lot_id)}">${icon('minus')}</button>` : `<button class="icon-mini danger" title="ไปตรวจวันศุกร์" data-route="weekly">${icon('check')}</button>`}</div></td></tr>`).join('');
}

function buildMaterialGroups(summaries = [], lots = []) {
  const map = new Map();
  summaries.forEach(s => map.set(s.material_code, {...s, lots:[]}));
  lots.forEach(l => {
    if (!map.has(l.material_code)) map.set(l.material_code, {
      material_code:l.material_code, material_name:l.material_name, label_name:l.label_name,
      unit:l.unit, min_qty:l.min_qty, responsible_email:l.responsible_email,
      responsible_name:l.responsible_name, total_balance:0, active_lots:0,
      nearest_expiry:null, expired_pending_lots:0, expired_pending_balance:0, alert_mode:l.alert_mode || 'MINIMUM', reorder_day:l.reorder_day || 1, needs_reorder:false, lots:[]
    });
    map.get(l.material_code).lots.push(l);
  });
  return [...map.values()].map(g => {
    const activeLots = g.lots.filter(l => Number(l.balance) > 0 && !isExpired(l));
    const expiredLots = g.lots.filter(l => Number(l.balance) > 0 && isExpired(l));
    const negativeLots = g.lots.filter(l => Number(l.balance) < 0);
    const nearestLot = activeLots.filter(l => l.expiry_date).sort((a,b) => String(a.expiry_date).localeCompare(String(b.expiry_date)))[0];
    const nearestExpiry = g.nearest_expiry || nearestLot?.expiry_date || null;
    let daysToNearest = nearestLot?.days_to_expiry ?? null;
    if (daysToNearest === null && nearestExpiry) {
      daysToNearest = Math.ceil((new Date(`${nearestExpiry}T00:00:00`) - todayStart()) / 86400000);
    }
    return {...g,
      total_balance:Number(g.total_balance || 0), min_qty:Number(g.min_qty || 0),
      alert_mode:g.alert_mode || 'MINIMUM', reorder_day:Number(g.reorder_day || 1), needs_reorder:Boolean(g.needs_reorder),
      activeLots, expiredLots, negativeLots,
      active_lots:Number(g.active_lots || activeLots.length),
      expired_pending_lots:Number(g.expired_pending_lots || expiredLots.length),
      nearest_expiry:nearestExpiry,
      days_to_nearest:daysToNearest
    };
  }).sort((a,b) => a.material_code.localeCompare(b.material_code, 'th'));
}

function materialGroupStatus(g) {
  if (g.expired_pending_lots > 0) return {key:'expired',label:`หมดอายุรอนำออก ${g.expired_pending_lots} Lot`,badge:'danger'};
  if (g.negativeLots.length || g.total_balance < 0) return {key:'negative',label:'ยอดติดลบ',badge:'danger'};
  if (g.alert_mode === 'MONTHLY') {
    if (g.needs_reorder) return {key:'reorder',label:'ถึงรอบเบิก',badge:'warn'};
    if (g.total_balance <= 0) return {key:'current-use',label:'ใช้ชุดปัจจุบันอยู่',badge:'info'};
  } else if (g.alert_mode === 'NONE') {
    if (g.total_balance <= 0) return {key:'notrack',label:'ไม่เปิดแจ้งเตือน',badge:'info'};
  } else {
    if (g.total_balance <= 0) return {key:'out',label:'สินค้าหมด',badge:'danger'};
    if (g.total_balance < g.min_qty) return {key:'low',label:'ต่ำกว่าขั้นต่ำ',badge:'warn'};
  }
  if (g.days_to_nearest !== null && Number(g.days_to_nearest) <= 30) return {key:'expiry',label:'ใกล้หมดอายุ',badge:'warn'};
  return {key:'positive',label:'คงเหลือปกติ',badge:'ok'};
}

function materialStockCard(g) {
  const st = materialGroupStatus(g);
  const ratio = g.min_qty > 0 ? Math.max(0, Math.min(100, g.total_balance / g.min_qty * 100)) : (g.total_balance > 0 ? 100 : 0);
  const ownerKey = g.responsible_email || 'unassigned';
  return `<article class="material-stock-card status-${st.key}">
    <div class="material-stock-main">
      <div class="material-ident"><button class="material-title-link" type="button" data-material-detail="${esc(g.material_code)}">${esc(g.material_name)}</button><button class="owner-inline-link" type="button" data-owner-detail="${esc(ownerKey)}">${icon('user')} ${esc(g.responsible_name || 'ยังไม่กำหนด')}</button></div>
      <div class="material-balance"><span>คงเหลือรวม</span><div><strong>${qty(g.total_balance)}</strong><small>${esc(g.unit)}</small></div><div class="level-track" title="เทียบกับขั้นต่ำ ${qty(g.min_qty)}"><i style="width:${ratio}%"></i></div><small>ขั้นต่ำ ${qty(g.min_qty)} ${esc(g.unit)}</small></div>
      <div class="material-facts"><div><span>Lot ที่ใช้งาน</span><strong>${g.active_lots}</strong></div><div><span>หมดอายุใกล้สุด</span><strong>${g.nearest_expiry ? d(g.nearest_expiry) : '-'}</strong></div><div><span>สถานะ</span><em class="badge ${st.badge}">${st.label}</em></div></div>
    </div>
    <div class="material-stock-actions"><button class="mini ghost" type="button" data-material-detail="${esc(g.material_code)}">ดู Lot ทั้งหมด</button><button class="mini" type="button" data-material-usage="${esc(g.material_code)}">${icon('chart')} วิเคราะห์การใช้</button></div>
  </article>`;
}

async function ensureInventorySummary() {
  if (inventorySummaryCache.length) return inventorySummaryCache;
  const {data,error} = await sb.from('v_inventory_summary').select('*').order('material_code');
  if (error) throw error;
  inventorySummaryCache = data || [];
  return inventorySummaryCache;
}

async function openMaterialStockDetail(code) {
  try {
    const [summaries, lotRes] = await Promise.all([
      ensureInventorySummary(),
      sb.from('v_lot_balances').select('*').eq('active', true).eq('material_code', code).order('lot_no')
    ]);
    if (lotRes.error) throw lotRes.error;
    const lots=(lotRes.data || []).filter(x => Number(x.balance) !== 0);
    stockCache = [...new Map([...stockCache, ...lots].map(x => [x.lot_id, x])).values()];
    const g = buildMaterialGroups(summaries.filter(x => x.material_code === code), lots).find(x => x.material_code === code);
    if (!g) return toast('ไม่พบสินค้านี้', true);
    const st = materialGroupStatus(g);
    const rows = [...g.lots].sort((a,b) => (isExpired(b)-isExpired(a)) || String(a.expiry_date || '9999').localeCompare(String(b.expiry_date || '9999')));
    openModal(`<div class="detail-modal-head"><div><h3>${esc(g.material_name)}</h3><p>${esc(g.responsible_name || 'ยังไม่กำหนด')} · ขั้นต่ำ ${qty(g.min_qty)} ${esc(g.unit)}</p></div></div><div class="detail-kpis"><div><span>คงเหลือรวม</span><strong>${qty(g.total_balance)}</strong><small>${esc(g.unit)}</small></div><div><span>Lot ที่ใช้งาน</span><strong>${g.active_lots}</strong><small>Lot</small></div><div><span>สถานะ</span><em class="badge ${st.badge}">${st.label}</em></div></div><div class="actions"><button class="primary" data-material-usage="${esc(g.material_code)}">${icon('chart')} วิเคราะห์การใช้</button><button class="secondary modal-close">ปิด</button></div><div class="section-title compact"><div><h3>รายการ Lot</h3><p class="muted small">โหลดเฉพาะ Lot ของสินค้าที่เลือก</p></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Lot / QR</th><th>คงเหลือ</th><th>EXP</th><th>สถานะ</th><th></th></tr></thead><tbody>${lotTableRows(rows) || '<tr><td colspan="5" class="empty">ไม่มี Lot ที่มียอดคงเหลือ</td></tr>'}</tbody></table></div>`);
  } catch (e) { toast(errMsg(e), true); }
}

async function openOwnerDetail(ownerKey) {
  try {
    const summaries=await ensureInventorySummary();
    const unassigned = !ownerKey || ownerKey === 'unassigned';
    let lotQuery=sb.from('v_lot_balances').select('*').eq('active', true);
    lotQuery=unassigned ? lotQuery.is('responsible_email', null) : lotQuery.eq('responsible_email', ownerKey);
    const lotRes=await lotQuery.order('material_code').order('lot_no');
    if (lotRes.error) throw lotRes.error;
    const lots=(lotRes.data || []).filter(x => Number(x.balance) !== 0);
    stockCache = [...new Map([...stockCache, ...lots].map(x => [x.lot_id, x])).values()];
    const rows = summaries.filter(x => unassigned ? !x.responsible_email : x.responsible_email === ownerKey);
    const groups = buildMaterialGroups(rows, lots);
    const name = groups[0]?.responsible_name || (unassigned ? 'ยังไม่กำหนดผู้ดูแล' : ownerKey);
    const low = groups.filter(g => ['low','reorder'].includes(materialGroupStatus(g).key)).length;
    const out = groups.filter(g => materialGroupStatus(g).key === 'out').length;
    const expired = groups.reduce((s,g) => s + g.expired_pending_lots,0);
    openModal(`<div class="owner-detail-head"><span class="owner-avatar large">${esc(name.trim().charAt(0) || '?')}</span><div><h3>${esc(name)}</h3><p>${unassigned ? 'ยังไม่ได้กำหนดผู้ดูแล' : esc(ownerKey)}</p></div></div><div class="detail-kpis four"><div><span>ดูแลทั้งหมด</span><strong>${groups.length}</strong><small>รายการ</small></div><div><span>ต่ำกว่าขั้นต่ำ</span><strong>${low}</strong><small>รายการ</small></div><div><span>สินค้าหมด</span><strong>${out}</strong><small>รายการ</small></div><div><span>หมดอายุรอนำออก</span><strong>${expired}</strong><small>Lot</small></div></div><div class="owner-material-list">${groups.map(g => { const st=materialGroupStatus(g); return `<div class="owner-material-row"><button data-material-detail="${esc(g.material_code)}"><span>${esc(g.material_name)}</span></button><div><span class="table-number">${qty(g.total_balance)}</span> ${esc(g.unit)}<em class="badge ${st.badge}">${st.label}</em></div><button class="icon-mini" title="วิเคราะห์การใช้" data-material-usage="${esc(g.material_code)}">${icon('chart')}</button></div>`; }).join('') || '<div class="empty">ไม่มีรายการที่รับผิดชอบ</div>'}</div>`);
  } catch (e) { toast(errMsg(e), true); }
}


async function renderMyStock(tab = 'overview') {
  myStockTab = ['overview','reorder','settings'].includes(tab) ? tab : 'overview';
  const {data,error} = await sb.from('v_inventory_summary').select('*').eq('responsible_email', profile.email).order('material_name');
  if (error) throw error;
  const groups = buildMaterialGroups(data || [], []);
  const reorder = groups.filter(g => g.needs_reorder);
  const monthly = groups.filter(g => g.alert_mode === 'MONTHLY').length;
  const tabBar = `<div class="my-stock-tabs"><button data-my-stock-tab="overview" class="${myStockTab==='overview'?'active':''}">ภาพรวม</button><button data-my-stock-tab="reorder" class="${myStockTab==='reorder'?'active':''}">ต้องเบิก <span>${reorder.length}</span></button><button data-my-stock-tab="settings" class="${myStockTab==='settings'?'active':''}">ตั้งค่าการเตือน</button></div>`;
  const summary = `<div class="my-stock-kpis"><div><span>ดูแลทั้งหมด</span><strong>${groups.length}</strong><small>รายการ</small></div><div><span>ต้องเบิก</span><strong>${reorder.length}</strong><small>รายการ</small></div><div><span>เตือนรายเดือน</span><strong>${monthly}</strong><small>รายการ</small></div></div>`;
  const overviewCards = groups.map(g=>{const st=materialGroupStatus(g);return `<article class="my-stock-card"><div class="my-stock-title"><div><h3>${esc(g.material_name)}</h3><p>คงเหลือ ${qty(g.total_balance)} ${esc(g.unit)} · ${g.active_lots} Lot</p></div><em class="badge ${st.badge}">${st.label}</em></div><div class="my-stock-meta"><span>${g.alert_mode==='MONTHLY' ? `เตือนวันที่ ${g.reorder_day} ของเดือน` : g.alert_mode==='NONE' ? 'ไม่เปิดแจ้งเตือน' : `ขั้นต่ำ ${qty(g.min_qty)} ${esc(g.unit)}`}</span></div><div class="my-stock-actions"><button type="button" class="mini ghost" data-material-detail="${esc(g.material_code)}">ดู Lot</button><button type="button" class="mini" data-material-usage="${esc(g.material_code)}">${icon('chart')} วิเคราะห์</button></div></article>`;}).join('');
  const reorderCards = reorder.map(g=>{const st=materialGroupStatus(g);return `<article class="my-stock-card needs-reorder"><div class="my-stock-title"><div><h3>${esc(g.material_name)}</h3><p>คงเหลือ ${qty(g.total_balance)} ${esc(g.unit)}</p></div><em class="badge ${st.badge}">${st.label}</em></div><div class="my-stock-actions"><button type="button" class="primary" data-route="move" data-move-tab="receive">รับเข้า</button><button type="button" class="mini" data-material-usage="${esc(g.material_code)}">ดูการใช้</button></div></article>`;}).join('');
  const settingsCards = groups.map(g=>`<form class="my-stock-card my-stock-setting-card" data-my-settings-form data-material-code="${esc(g.material_code)}"><div class="my-stock-title"><div><h3>${esc(g.material_name)}</h3><p>คงเหลือ ${qty(g.total_balance)} ${esc(g.unit)}</p></div></div><div class="stock-setting-grid"><label>รูปแบบแจ้งเตือน<select name="alert_mode"><option value="MINIMUM" ${g.alert_mode==='MINIMUM'?'selected':''}>เตือนตามจำนวนขั้นต่ำ</option><option value="MONTHLY" ${g.alert_mode==='MONTHLY'?'selected':''}>เตือนรอบเบิกรายเดือน</option><option value="NONE" ${g.alert_mode==='NONE'?'selected':''}>ไม่แจ้งเตือน</option></select></label><label data-minimum-field>จำนวนขั้นต่ำ<input name="minimum" type="number" min="0" step="0.01" value="${Number(g.min_qty || 0)}" inputmode="decimal"></label><label data-reorder-field>วันที่เตือนของเดือน (1–28)<input name="reorder_day" type="number" min="1" max="28" step="1" value="${Number(g.reorder_day || 1)}" inputmode="numeric"></label></div><button class="primary" type="submit">บันทึกการตั้งค่า</button></form>`).join('');
  const body = myStockTab==='settings' ? settingsCards : myStockTab==='reorder' ? (reorderCards || '<div class="card empty">ยังไม่มีสินค้าที่ถึงรอบเบิก</div>') : overviewCards;
  page.innerHTML = `<div class="page-head"><div><h2>สต๊อกที่ฉันดูแล</h2></div></div>${tabBar}${summary}<div class="my-stock-list">${body || '<div class="card empty">ยังไม่มีสินค้าที่กำหนดให้คุณดูแล</div>'}</div>`;
  $$('[data-my-stock-tab]').forEach(b=>b.addEventListener('click',()=>renderMyStock(b.dataset.myStockTab)));
  $$('[data-my-settings-form]').forEach(form=>{
    const mode=form.elements.alert_mode;
    const toggle=()=>{
      form.querySelector('[data-minimum-field]').classList.toggle('hidden',mode.value!=='MINIMUM');
      form.querySelector('[data-reorder-field]').classList.toggle('hidden',mode.value!=='MONTHLY');
    };
    mode.addEventListener('change',toggle); toggle();
    form.addEventListener('submit',async e=>{
      e.preventDefault();
      const fd=new FormData(form);
      const min=Number(fd.get('minimum') || 0);
      const day=Number(fd.get('reorder_day') || 1);
      const btn=e.submitter; btn.disabled=true;
      const {error}=await sb.rpc('fn_update_my_stock_settings',{p_material_code:form.dataset.materialCode,p_min_qty:min,p_alert_mode:String(fd.get('alert_mode')),p_reorder_day:day,p_acting_mode:actingMode});
      btn.disabled=false;
      if(error)return toast(errMsg(error),true);
      inventorySummaryCache=[]; toast('บันทึกการตั้งค่าแล้ว'); renderMyStock('settings');
    });
  });
}

async function renderStock(initialFilter = 'select') {
  const summaryRes = await sb.from('v_inventory_summary').select('*').order('material_code');
  if (summaryRes.error) throw summaryRes.error;
  inventorySummaryCache = summaryRes.data || [];
  const groups = buildMaterialGroups(inventorySummaryCache, []);
  const materialOptions = groups.map(g => ({code:g.material_code,name:g.material_name,label_name:g.material_name,unit:g.unit,responsible_email:g.responsible_email,responsible_name:g.responsible_name}));
  const stockOwners=[...new Map(groups.filter(g=>g.responsible_email).map(g=>[g.responsible_email,g.responsible_name || g.responsible_email])).entries()].sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'th'));
  const stockOwnerOptions='<option value="">ทุกคน</option>'+stockOwners.map(([email,name])=>`<option value="${esc(email)}">${esc(name)}</option>`).join('');
  const activeLots = groups.reduce((s,g) => s + g.active_lots,0);
  const reorderCount = groups.filter(g => g.needs_reorder).length;
  const nearCount = groups.filter(g => g.days_to_nearest !== null && Number(g.days_to_nearest) >= 0 && Number(g.days_to_nearest) <= 30).length;
  const outCount = groups.filter(g => materialGroupStatus(g).key === 'out').length;
  const selectedFilter = initialFilter && initialFilter !== 'select' ? initialFilter : '';
  page.innerHTML = `<div class="page-head stock-page-head"><div><h2>สต๊อกคงเหลือ</h2><p class="muted small">เลือกสถานะ หรือพิมพ์ชื่อสินค้าบางส่วน ระบบจึงจะแสดงรายการ</p></div><button class="mini" data-route="usage">${icon('chart')} วิเคราะห์การใช้</button></div><div class="stock-summary-strip"><div><span>สินค้า</span><strong>${groups.length}</strong><small>รายการ</small></div><div><span>Lot ใช้งาน</span><strong>${activeLots}</strong><small>Lot</small></div><div><span>ต้องเบิก</span><strong>${reorderCount}</strong><small>รายการ</small></div><div><span>สินค้าหมด</span><strong>${outCount}</strong><small>รายการ</small></div><div><span>ใกล้หมดอายุ</span><strong>${nearCount}</strong><small>รายการ</small></div></div><section class="card stock-choice-card three"><label>เลือกผู้ดูแล<select id="stockOwnerFilter">${stockOwnerOptions}</select></label><label>เลือกสถานะ<select id="stockStatusSelect"><option value="">กรุณาเลือกสถานะ</option><option value="all">ทั้งหมด</option><option value="positive">คงเหลือปกติ</option><option value="reorder">ถึงรอบเบิก</option><option value="low">ต่ำกว่าขั้นต่ำ</option><option value="out">สินค้าหมด</option><option value="current-use">ใช้ชุดปัจจุบันอยู่</option><option value="notrack">ไม่เปิดแจ้งเตือน</option><option value="expiry">ใกล้หมดอายุ</option><option value="expired">หมดอายุรอนำออก</option><option value="negative">ยอดติดลบ</option></select></label>${materialComboboxMarkup({id:'stockMaterialCode',label:'หรือค้นหาสินค้า',placeholder:'พิมพ์ชื่อสินค้าบางส่วน',materials:materialOptions})}</section><div id="materialStockList" class="material-stock-list"></div>`;
  const statusSelect=$('#stockStatusSelect');
  statusSelect.value=selectedFilter;
  const draw = () => {
    const filter=statusSelect.value;
    const code=$('#stockMaterialCode').value;
    if (!filter && !code) {
      $('#materialStockList').innerHTML='<div class="card select-first-state">'+icon('box')+'<div><strong>กรุณาเลือกสถานะหรือค้นหาสินค้า</strong><span>พิมพ์ชื่อบางส่วนได้ ไม่ต้องเลื่อนหารายการยาว ๆ</span></div></div>';
      return;
    }
    let arr=groups;
    const owner=$('#stockOwnerFilter').value;
    if(owner) arr=arr.filter(g=>g.responsible_email===owner);
    if (code) arr=arr.filter(g=>g.material_code===code);
    if (filter && filter!=='all') arr=arr.filter(g=>materialGroupStatus(g).key===filter);
    $('#materialStockList').innerHTML=arr.map(materialStockCard).join('') || `<div class="card empty">${icon('search')}<div>ไม่พบรายการตามตัวเลือก</div></div>`;
  };
  const materialCombo=setupMaterialCombobox('stockMaterialCode',materialOptions,{ownerSelectId:'stockOwnerFilter',onChange:(code)=>{if(code)statusSelect.value='';draw();}});
  $('#stockOwnerFilter').addEventListener('change',draw);
  statusSelect.addEventListener('change',()=>{if(statusSelect.value)materialCombo.clear(false);draw();});
  draw();
}

function dateInputValue(date) {
  const y=date.getFullYear(), m=String(date.getMonth()+1).padStart(2,'0'), day=String(date.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function transactionReferenceDate(row) {
  if (row?.tx_type === 'EXPIRED' && /^\d{4}-\d{2}-\d{2}$/.test(String(row.expiry_date || ''))) return row.expiry_date;
  return row?.created_at ? new Date(row.created_at).toLocaleDateString('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}) : '';
}

async function fetchPagedTransactions(buildQuery) {
  const all=[]; const pageSize=1000;
  for (let offset=0; offset<50000; offset+=pageSize) {
    const q=await buildQuery().range(offset,offset+pageSize-1);
    if (q.error) throw q.error;
    const rows=q.data || []; all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

async function fetchMaterialTransactions(code, fromDate, toDate) {
  const [byActionDate, byExpiryDate] = await Promise.all([
    fetchPagedTransactions(() => sb.from('v_transaction_history').select('*').eq('canonical_code',code)
      .gte('created_at',`${fromDate}T00:00:00+07:00`).lte('created_at',`${toDate}T23:59:59.999+07:00`)
      .order('created_at',{ascending:false})),
    fetchPagedTransactions(() => sb.from('v_transaction_history').select('*').eq('canonical_code',code).eq('tx_type','EXPIRED')
      .not('expiry_date','is',null).gte('expiry_date',fromDate).lte('expiry_date',toDate)
      .order('expiry_date',{ascending:false}).order('created_at',{ascending:false}))
  ]);
  const merged=new Map();
  [...byActionDate,...byExpiryDate].forEach(row=>merged.set(row.id || `${row.tx_type}:${row.lot_id}:${row.created_at}`,row));
  return [...merged.values()].filter(row=>{
    const reference=transactionReferenceDate(row);
    return reference && reference>=fromDate && reference<=toDate;
  }).sort((a,b)=>transactionReferenceDate(b).localeCompare(transactionReferenceDate(a)) || String(b.created_at||'').localeCompare(String(a.created_at||'')));
}

function usageMonthLabel(key) {
  const [y,m]=key.split('-').map(Number);
  return new Date(y,m-1,1).toLocaleDateString('th-TH',{month:'short',year:'2-digit'});
}

function renderUsageResult(material, rows, fromDate, toDate, summary) {
  const from=new Date(`${fromDate}T00:00:00`), to=new Date(`${toDate}T00:00:00`);
  const days=Math.max(1,Math.floor((to-from)/86400000)+1);
  const receiveRows=rows.filter(x=>x.tx_type==='RECEIVE');
  const issueRows=rows.filter(x=>x.tx_type==='ISSUE');
  const expiredRows=rows.filter(x=>x.tx_type==='EXPIRED');
  const received=receiveRows.reduce((s,x)=>s+Math.abs(Number(x.quantity_delta||0)),0);
  const used=issueRows.reduce((s,x)=>s+Math.abs(Number(x.quantity_delta||0)),0);
  const expired=expiredRows.reduce((s,x)=>s+Math.abs(Number(x.quantity_delta||0)),0);
  const avgWeek=used/days*7, avgMonth=used/days*30.4375, avgYear=used/days*365.25;
  const map=new Map();
  rows.forEach(x=>{ const reference=transactionReferenceDate(x); const k=reference.slice(0,7); if(!k)return; if(!map.has(k))map.set(k,{receive:0,issue:0,expired:0}); const v=map.get(k); if(x.tx_type==='RECEIVE')v.receive+=Math.abs(Number(x.quantity_delta||0)); if(x.tx_type==='ISSUE')v.issue+=Math.abs(Number(x.quantity_delta||0)); if(x.tx_type==='EXPIRED')v.expired+=Math.abs(Number(x.quantity_delta||0)); });
  const monthKeys=[]; const cursor=new Date(from.getFullYear(),from.getMonth(),1); const last=new Date(to.getFullYear(),to.getMonth(),1);
  while(cursor<=last){monthKeys.push(`${cursor.getFullYear()}-${String(cursor.getMonth()+1).padStart(2,'0')}`);cursor.setMonth(cursor.getMonth()+1);}
  const months=monthKeys.slice(-18).map(k=>[k,map.get(k)||{receive:0,issue:0,expired:0}]);
  const max=Math.max(1,...months.flatMap(([,v])=>[v.receive,v.issue,v.expired]));
  const adjustment=rows.filter(x=>!['RECEIVE','ISSUE','EXPIRED'].includes(x.tx_type)).length;
  return `<div class="usage-summary-head"><div><h3>${esc(material.name)}</h3><p>${d(fromDate)} – ${d(toDate)} · ${days.toLocaleString('th-TH')} วัน</p></div><button class="mini ghost" data-material-detail="${esc(material.code)}">ดูสต๊อกปัจจุบัน</button></div><div class="usage-kpi-grid usage-kpi-grid-7"><div class="usage-kpi current"><span>คงเหลือปัจจุบัน</span><strong>${qty(summary?.total_balance || 0)}</strong><small>${esc(material.unit || '')}</small></div><div class="usage-kpi receive"><span>นำเข้าช่วงนี้</span><strong>${qty(received)}</strong><small>${esc(material.unit || '')} · ${receiveRows.length} ครั้ง</small></div><div class="usage-kpi issue"><span>นำออก/ใช้ช่วงนี้</span><strong>${qty(used)}</strong><small>${esc(material.unit || '')} · ${issueRows.length} ครั้ง</small></div><div class="usage-kpi expired"><span>หมดอายุตามวัน EXP</span><strong>${qty(expired)}</strong><small>${esc(material.unit || '')} · ${expiredRows.length} ครั้ง</small></div><div class="usage-kpi"><span>เฉลี่ยต่อสัปดาห์</span><strong>${qty(avgWeek)}</strong><small>${esc(material.unit || '')}/สัปดาห์</small></div><div class="usage-kpi"><span>เฉลี่ยต่อเดือน</span><strong>${qty(avgMonth)}</strong><small>${esc(material.unit || '')}/เดือน</small></div><div class="usage-kpi"><span>เฉลี่ยต่อปี</span><strong>${qty(avgYear)}</strong><small>${esc(material.unit || '')}/ปี</small></div></div><div class="usage-grid"><section class="card usage-chart-card"><div class="section-title compact"><div><h3>นำเข้า–นำออก–หมดอายุ รายเดือน</h3><p class="muted small">หมดอายุจัดเดือนตามวัน EXP ไม่ใช่วันที่กดยืนยันนำออก</p></div><div class="chart-legend"><span class="receive">นำเข้า</span><span class="issue">นำออก</span><span class="expired">หมดอายุ</span></div></div><div class="usage-bars">${months.map(([k,v])=>`<div class="usage-bar-row"><span>${usageMonthLabel(k)}</span><div class="bar-pair"><div class="bar-track"><i class="receive" style="width:${v.receive/max*100}%"></i></div><div class="bar-track"><i class="issue" style="width:${v.issue/max*100}%"></i></div><div class="bar-track"><i class="expired" style="width:${v.expired/max*100}%"></i></div></div><div class="bar-values three"><b>+${qty(v.receive)}</b><b>-${qty(v.issue)}</b><b>หมด ${qty(v.expired)}</b></div></div>`).join('') || '<div class="empty">ไม่มีรายการในช่วงวันที่นี้</div>'}</div></section><section class="card usage-note-card"><h3>วิธีอ่านค่าเฉลี่ย</h3><p>ระบบนับ “การใช้” จากรายการ <b>นำออก (ISSUE)</b> เท่านั้น ส่วนของหมดอายุแสดงแยก ไม่รวมเป็นการใช้จริง และจัดเข้ารายเดือนตามวัน EXP ของ Lot</p><div class="expiry-method-note"><strong>การอ่านกราฟหมดอายุ</strong><span>เช่น Lot หมดอายุเดือนมีนาคม แต่เจ้าหน้าที่เพิ่งยืนยันนำออกเดือนกรกฎาคม ระบบจะแสดงในเดือนมีนาคม</span></div><dl><div><dt>เฉลี่ย/สัปดาห์</dt><dd>ยอดใช้ ÷ จำนวนวัน × 7</dd></div><div><dt>เฉลี่ย/เดือน</dt><dd>ยอดใช้ ÷ จำนวนวัน × 30.44</dd></div><div><dt>เฉลี่ย/ปี</dt><dd>ยอดใช้ ÷ จำนวนวัน × 365.25</dd></div></dl>${adjustment?`<p class="usage-warning">พบรายการปรับยอด/ชำรุด ${adjustment} รายการ ซึ่งไม่รวมในการคำนวณการใช้</p>`:''}</section></div><section class="card usage-history-card"><div class="section-title compact"><div><h3>ประวัติของสินค้านี้</h3><p class="muted small">${rows.length.toLocaleString('th-TH')} รายการในช่วงที่เลือก</p></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>วันเวลา</th><th>ประเภท</th><th>Lot</th><th>เปลี่ยนแปลง</th><th>ยอดหลังทำ</th><th>ผู้บันทึก</th></tr></thead><tbody>${rows.slice(0,300).map(x=>`<tr><td>${x.tx_type==='EXPIRED'&&x.expiry_date?`<span class="usage-expiry-date"><strong>EXP ${d(x.expiry_date)}</strong><small>ยืนยันนำออก ${dt(x.created_at)}</small></span>`:dt(x.created_at)}</td><td>${x.tx_type==='RECEIVE'?'<span class="badge ok">นำเข้า</span>':x.tx_type==='ISSUE'?'<span class="badge info">นำออก</span>':x.tx_type==='EXPIRED'?'<span class="badge danger">หมดอายุ</span>':`<span class="badge warn">${esc(x.tx_type)}</span>`}</td><td>${esc(x.lot_key)}</td><td class="${x.tx_type==='ISSUE'?'negative-text':x.tx_type==='EXPIRED'?'expired-text':'positive-text'}">${x.tx_type==='RECEIVE'?'+':''}${qty(x.quantity_delta)} ${esc(x.unit)}</td><td>${qty(x.quantity_after)}</td><td>${esc(x.created_by_name || x.created_by_email || 'SYSTEM')}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">ไม่มีข้อมูล</td></tr>'}</tbody></table></div>${rows.length>300?'<p class="field-hint">ตารางแสดง 300 รายการล่าสุด แต่ค่ารวมคำนวณจากข้อมูลทั้งหมด</p>':''}</section>`;
}

async function renderUsage(selectedCode = '') {
  const [rawMats,summaries]=await Promise.all([loadMaterials(),ensureInventorySummary()]);
  const summaryMap=new Map(summaries.map(x=>[x.material_code,x]));
  const mats=rawMats.map(m=>({...m,responsible_name:summaryMap.get(m.code)?.responsible_name||m.responsible_email||'ยังไม่กำหนด'}));
  const usageOwners=[...new Map(mats.filter(m=>m.responsible_email).map(m=>[m.responsible_email,m.responsible_name])).entries()].sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'th'));
  const usageOwnerOptions='<option value="">ทุกคน</option>'+usageOwners.map(([email,name])=>`<option value="${esc(email)}">${esc(name)}</option>`).join('');
  const today=new Date(), start=new Date(today); start.setFullYear(start.getFullYear()-1); start.setDate(start.getDate()+1);
  const initial=selectedCode && mats.some(m=>m.code===selectedCode) ? selectedCode : '';
  page.innerHTML = `<div class="page-head"><div><h2>วิเคราะห์การใช้สินค้า</h2><p class="muted small">พิมพ์ชื่อสินค้าบางส่วน แล้วเลือกช่วงวันที่ก่อนคำนวณ</p></div></div><form id="usageFilterForm" class="card usage-filter-card"><label>กรองผู้ดูแล<select id="usageOwnerFilter">${usageOwnerOptions}</select></label>${materialComboboxMarkup({id:'usageMaterial',label:'สินค้า',placeholder:'พิมพ์ชื่อสินค้าบางส่วน',materials:mats,initialCode:initial})}<div class="form-grid two"><label>ตั้งแต่วันที่<input id="usageFrom" type="date" value="${dateInputValue(start)}" required></label><label>ถึงวันที่<input id="usageTo" type="date" value="${dateInputValue(today)}" required></label></div><div class="usage-filter-actions"><div class="preset-group"><button type="button" data-usage-days="30">30 วัน</button><button type="button" data-usage-days="90">90 วัน</button><button type="button" data-usage-days="365" class="active">1 ปี</button><button type="button" data-usage-all>ทั้งหมด</button></div><button class="primary" type="submit">${icon('chart')} คำนวณ</button></div></form><div id="usageResult"><div class="card select-first-state">${icon('chart')}<div><strong>กรุณาค้นหาและเลือกสินค้า</strong><span>ยังไม่มีการโหลดประวัติ จนกว่าจะเลือกสินค้าและกดคำนวณ</span></div></div></div>`;
  const resetResult=()=>{$('#usageResult').innerHTML='<div class="card select-first-state">'+icon('chart')+'<div><strong>กรุณาค้นหาและเลือกสินค้า</strong><span>พิมพ์ชื่อบางส่วนได้ ไม่ต้องเลื่อนหารายการยาว ๆ</span></div></div>';};
  const load = async () => {
    const code=$('#usageMaterial').value, from=$('#usageFrom').value, to=$('#usageTo').value;
    if (!code) return toast('กรุณาค้นหาและเลือกสินค้า',true);
    if (!from || !to) return toast('กรุณาเลือกช่วงวันที่',true);
    if (from>to) return toast('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด',true);
    usageMaterialCode=code;
    $('#usageResult').innerHTML='<div class="card usage-loading">กำลังคำนวณจากประวัติรับเข้า–นำออก และวัน EXP…</div>';
    try {
      const [rows,summaries]=await Promise.all([fetchMaterialTransactions(code,from,to),ensureInventorySummary()]);
      const mat=mats.find(m=>m.code===code);
      const sum=summaries.find(s=>s.material_code===code);
      $('#usageResult').innerHTML=renderUsageResult(mat,rows,from,to,sum);
      queueResponsiveTables($('#usageResult'));
    } catch(e) { $('#usageResult').innerHTML=`<div class="card notice">${esc(errMsg(e))}</div>`; }
  };
  setupMaterialCombobox('usageMaterial',mats,{ownerSelectId:'usageOwnerFilter',onChange:(code)=>{if(code)load();else resetResult();}});
  $('#usageFilterForm').addEventListener('submit',e=>{e.preventDefault();load();});
  $$('[data-usage-days]').forEach(b=>b.addEventListener('click',()=>{const end=new Date();const begin=new Date(end);begin.setDate(begin.getDate()-Number(b.dataset.usageDays)+1);$('#usageFrom').value=dateInputValue(begin);$('#usageTo').value=dateInputValue(end);$$('[data-usage-days]').forEach(x=>x.classList.toggle('active',x===b));if($('#usageMaterial').value)load();}));
  $('[data-usage-all]').addEventListener('click',()=>{$('#usageFrom').value='2000-01-01';$('#usageTo').value=dateInputValue(new Date());$$('[data-usage-days]').forEach(x=>x.classList.remove('active'));if($('#usageMaterial').value)load();});
  if(initial) await load();
}

async function renderUrgent() {
  const [lots, summaryRes] = await Promise.all([getLots(true), sb.from('v_inventory_summary').select('*').order('material_name')]);
  if (summaryRes.error) throw summaryRes.error;
  const expired = lots.filter(x => requiresExpiryConfirmation(x) && Number(x.balance) > 0);
  const reorder = (summaryRes.data || []).filter(x => Boolean(x.needs_reorder));
  updateUrgentBadge(expired.length + reorder.length);
  page.innerHTML = `<div class="page-head"><div><h2>ติดตามเร่งด่วน</h2></div><span class="badge danger">${expired.length + reorder.length} รายการ</span></div><section class="urgent-banner"><div>${icon('alert')}<strong>ของหมดอายุต้องยืนยันหลังนำออกจากพื้นที่</strong></div><button class="primary" data-route="weekly">ไปตรวจวันศุกร์</button></section><div class="section-title"><h3>หมดอายุ · รอนำออก (${expired.length})</h3></div><div class="list">${expired.map(lotCard).join('') || '<div class="card empty">ไม่มี Lot หมดอายุค้าง</div>'}</div><div class="section-title"><h3>ถึงรอบเบิก (${reorder.length})</h3></div><div class="table-wrap"><table class="data-table compact-desktop-table"><thead><tr><th>สินค้า</th><th>คงเหลือ</th><th>รูปแบบเตือน</th><th>ผู้ดูแล</th><th>สถานะ</th></tr></thead><tbody>${reorder.map(x => `<tr><td><strong>${esc(x.material_name)}</strong></td><td>${qty(x.total_balance)} ${esc(x.unit)}</td><td>${x.alert_mode==='MONTHLY' ? `รายเดือน · วันที่ ${x.reorder_day}` : `ขั้นต่ำ ${qty(x.min_qty)}`}</td><td>${esc(x.responsible_name || '-')}</td><td><span class="badge warn">${x.alert_mode==='MONTHLY'?'ถึงรอบเบิก':Number(x.total_balance)<=0?'หมด':'ต่ำกว่าขั้นต่ำ'}</span></td></tr>`).join('') || '<tr><td colspan="5" class="empty">ไม่มีรายการต้องเบิก</td></tr>'}</tbody></table></div>`;
}

async function printLabel(lotId) {
  const popup = window.open('about:blank', 'cnmi_inventory_label', 'width=420,height=300');
  if (!popup) return toast('เบราว์เซอร์บล็อกหน้าพิมพ์ กรุณาอนุญาต Pop-up ของเว็บไซต์นี้', true);
  popup.document.write('<!doctype html><meta charset="utf-8"><title>กำลังเปิดหน้าพิมพ์</title><body style="font-family:system-ui;padding:24px">กำลังเปิดหน้าพิมพ์ QR Sticker…</body>');
  popup.document.close();
  try {
    let l = stockCache.find(x => x.lot_id === lotId);
    if (!l) {
      const lotRes=await sb.from('v_lot_balances').select('*').eq('lot_id',lotId).maybeSingle();
      if (lotRes.error) throw lotRes.error;
      l=lotRes.data;
    }
    if (!l) { popup.close(); return toast('ไม่พบ Lot', true); }
    const params = new URLSearchParams({
      code:l.material_code,
      name:l.label_name || l.material_name,
      lot:l.lot_no,
      exp:l.expiry_date ? d(l.expiry_date) : 'ไม่ระบุ',
      key:lotKey(l),
      qr:lotKey(l),
      auto:'1'
    });
    const labelUrl = new URL('label.html', location.href);
    labelUrl.search = params.toString();
    popup.location.replace(labelUrl.toString());
    (async () => { try { await sb.rpc('fn_log_label_print', {p_lot_id:lotId}); } catch (_) {} })();
  } catch (e) {
    popup.close();
    toast(errMsg(e), true);
  }
}

async function loadMaterials() {
  if (materialsCache.length) return materialsCache;
  const {data, error} = await sb.from('materials').select('*').eq('is_main', true).eq('status', 'Active').order('code');
  if (error) throw error;
  materialsCache = data || [];
  return materialsCache;
}

function transactionRows(rows, {showIssueMethod = false} = {}) {
  return (rows || []).map(x => `<tr><td>${dt(x.created_at)}</td><td><strong>${esc(x.material_name)}</strong></td><td><span class="code-pill">${esc(x.lot_key)}</span></td><td>${x.tx_type === 'RECEIVE' ? '+' : ''}${qty(x.quantity_delta)} ${esc(x.unit)}</td><td>${qty(x.quantity_after)}</td>${showIssueMethod ? `<td>${issueMethodBadge(x.issue_method)}</td>` : ''}<td>${esc(x.created_by_name || x.created_by_email || 'SYSTEM')}</td></tr>`).join('');
}

async function renderScanStock() {
  page.innerHTML = `<div class="page-head"><div><h2>สแกนตรวจ Lot</h2><p class="muted small">สแกน QR แล้วดูยอดคงเหลือ ผู้ดูแล ขั้นต่ำ และบันทึกตรวจวันศุกร์ได้ทันที</p></div><button class="mini ghost" data-route="weekly">ดูรายการตรวจทั้งหมด</button></div><div class="scan-stock-layout"><section class="card scan-stock-hero"><div class="scan-stock-icon">${icon('camera')}</div><div><h3>เปิดกล้องตรวจสต๊อก</h3><p>รองรับ QR ใหม่ รหัสเดิม และการพิมพ์รหัสเมื่อกล้องมีปัญหา</p></div><button class="primary camera-primary" type="button" data-camera-scan data-scan-mode="inspect">${icon('camera')} เปิดกล้องสแกน</button></section><section class="card"><form id="manualStockScanForm" class="form-grid"><label>พิมพ์รหัส QR / รหัสล็อต<div class="toolbar issue-code-row" style="margin:0"><input id="stockScanCode" autocomplete="off" placeholder="เช่น BB319-09062026" required><button type="submit" class="secondary">ตรวจสอบ</button></div></label></form><div class="scan-stock-help"><strong>หลังสแกน ระบบจะแสดง</strong><span>ชื่อวัสดุ · Lot · วันหมดอายุ · ยอด Lot และยอดรวม · ผู้ดูแล · ขั้นต่ำ · สถานะ</span></div></section></div>`;
  $('#manualStockScanForm').addEventListener('submit', e => { e.preventDefault(); const code=$('#stockScanCode').value.trim(); if(!code)return toast('กรุณาพิมพ์รหัส QR หรือรหัสล็อต',true); resolveStockCheckCode(code); });
}

function scannedLotStatus(l, summary) {
  if (isExpired(l)) return {label:'หมดอายุ · รอนำออก', badge:'danger'};
  if (summary?.needs_reorder) {
    if ((summary.alert_mode || 'MINIMUM') === 'MONTHLY') return {label:'ถึงรอบเบิก', badge:'warn'};
    if (Number(summary.total_balance || 0) <= 0) return {label:'หมด', badge:'danger'};
    return {label:'ต่ำกว่าขั้นต่ำ', badge:'warn'};
  }
  if (Number(l.balance || 0) <= 0) return {label:'หมด', badge:'danger'};
  return {label:'ปกติ', badge:'ok'};
}

async function getScannableLots(force = false) {
  if (!force && scanLotsCache.length && Date.now() - scanLotsLoadedAt < 30000) return scanLotsCache;
  const {data, error} = await sb.from('v_lot_balances').select('*').eq('active', true).order('material_code').order('lot_no');
  if (error) throw error;
  const lots = data || [];
  scanLotsCache = lots;
  scanLotsLoadedAt = Date.now();
  stockCache = [...new Map([...stockCache, ...lots].map(x => [x.lot_id, x])).values()];
  return lots;
}

async function resolveStockCheckCode(code) {
  const lots = await getScannableLots();
  const l = findLotByCode(code, lots);
  if (!l) return toast('ไม่พบ Lot จาก QR Code นี้ หรือ Lot ถูกปิดแล้ว', true);
  try {
    const [summaryRes, check] = await Promise.all([
      sb.from('v_inventory_summary').select('*').eq('material_code', l.material_code).maybeSingle(),
      ensureCheck()
    ]);
    if (summaryRes.error) throw summaryRes.error;
    const summary = summaryRes.data || null;
    let item = null;
    if (check?.id) {
      const itemRes = await sb.from('v_weekly_check_items').select('*').eq('check_id', check.id).eq('lot_id', l.lot_id).maybeSingle();
      if (itemRes.error) throw itemRes.error;
      item = itemRes.data || null;
      if (item) {
        const existing=(window._weeklyItems || []).filter(x=>x.item_id!==item.item_id);
        window._weeklyItems=[...existing,item];
      }
    }
    openScannedLotResult(l, summary, item);
  } catch (e) { toast(errMsg(e), true); }
}

function openScannedLotResult(l, summary, item) {
  const st = scannedLotStatus(l, summary);
  const canAct = item && canHandleItem(item);
  const checked = Boolean(item?.checked_at);
  let checkActions = '';
  if (item) {
    if (checked) checkActions = `<span class="badge ok">ตรวจแล้ว ${dt(item.checked_at)}</span>`;
    else if (!canAct) checkActions = `<span class="badge">รอ ${esc(item.responsible_name || 'ผู้ดูแล')}</span>`;
    else if (isExpired(l)) checkActions = `<button class="danger" type="button" data-expired-remove="${esc(item.item_id)}">ยืนยันนำออก</button>`;
    else checkActions = `<button class="primary" type="button" data-scan-confirm-check="${esc(item.item_id)}">ยืนยันตรวจแล้ว</button><button class="secondary" type="button" data-check="${esc(item.item_id)}">ปรับยอด</button>`;
  } else checkActions = `<button class="secondary" type="button" data-route="weekly">เปิดหน้าตรวจวันศุกร์</button>`;
  openModal(`<div class="scanned-result-head"><div><span class="eyebrow">ผลการสแกน</span><h3>${esc(l.material_name)}</h3><p>รหัส ${esc(l.material_code)}</p></div><em class="badge ${st.badge}">${st.label}</em></div><div class="scanned-lot-code"><span>Lot</span><strong>${esc(l.lot_no)}</strong><small>EXP ${d(l.expiry_date)}</small></div><div class="scanned-kpis"><div><span>คงเหลือ Lot นี้</span><strong>${qty(l.balance)}</strong><small>${esc(l.unit)}</small></div><div><span>คงเหลือรวม</span><strong>${qty(summary?.total_balance ?? l.balance)}</strong><small>${esc(l.unit)}</small></div><div><span>จำนวนขั้นต่ำ</span><strong>${qty(summary?.min_qty ?? l.min_qty)}</strong><small>${esc(l.unit)}</small></div></div><div class="scanned-owner"><span>${icon('user')}</span><div><small>ผู้ดูแล</small><strong>${esc(l.responsible_name || 'ยังไม่กำหนด')}</strong></div></div><div class="scanned-actions">${checkActions}<button class="mini ghost" type="button" data-material-detail="${esc(l.material_code)}">ดู Lot อื่นของวัสดุนี้</button><button class="mini ghost" type="button" data-scan-again>${icon('camera')} สแกน Lot ถัดไป</button></div>`);
}

async function confirmScannedCheck(itemId) {
  const x=(window._weeklyItems || []).find(i=>i.item_id===itemId);
  if(!x)return toast('ไม่พบรายการตรวจ กรุณาสแกนใหม่',true);
  if(!canHandleItem(x))return toast('รายการนี้เป็นความรับผิดชอบของ '+(x.responsible_name||x.responsible_email),true);
  const btn=$(`[data-scan-confirm-check]`);
  if(btn)btn.disabled=true;
  const {error}=await sb.rpc('fn_save_stock_check',{p_item_id:itemId,p_actual_qty:Number(x.current_balance),p_reason_code:null,p_reason_detail:null,p_acting_mode:actingMode});
  if(error){if(btn)btn.disabled=false;return toast(errMsg(error),true);}
  closeModal();stockCache=[]; scanLotsCache=[]; scanLotsLoadedAt=0;inventorySummaryCache=[];toast('ยืนยันตรวจแล้ว ยอดตรงกับระบบ');
}


function defaultLotFromToday(now = new Date()) {
  const dd = String(now.getDate()).padStart(2,'0');
  const mm = String(now.getMonth() + 1).padStart(2,'0');
  const yyyy = String(now.getFullYear());
  return `${dd}${mm}${yyyy}`;
}

function sanitizeLotValue(value) {
  return String(value ?? '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g,'');
}

function normalizeScannedCode(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[‐‑‒–—−]+/g,'-')
    .replace(/\|+/g,'-')
    .replace(/\s+/g,'')
    .trim();
}

function prepareLotInput(input, {autoFillBlank = false, showFallbackHint = false} = {}) {
  if (!input) return '';
  const original = String(input.value ?? '');
  let value = sanitizeLotValue(original);
  const removedInvalid = value !== original.trim().toUpperCase();
  if (!value && autoFillBlank) value = defaultLotFromToday();
  input.value = value;
  const ruleEl = $('#lotRule');
  if (!value) {
    input.setCustomValidity('');
    if (ruleEl) {
      ruleEl.classList.remove('invalid');
      ruleEl.textContent = showFallbackHint ? `ยังไม่ระบุ Lot · ระบบจะใช้วันที่นำเข้า ${defaultLotFromToday()}` : 'กรอกได้เฉพาะตัวเลข 0–9 และภาษาอังกฤษ A–Z';
    }
    return value;
  }
  if (!/^[A-Z0-9]+$/.test(value)) {
    input.setCustomValidity('Lot ต้องเป็นตัวเลขและ/หรือตัวอักษรภาษาอังกฤษเท่านั้น');
    if (ruleEl) {
      ruleEl.classList.add('invalid');
      ruleEl.textContent = 'Lot ต้องมีเฉพาะตัวเลข 0–9 และภาษาอังกฤษ A–Z เท่านั้น';
    }
    return value;
  }
  input.setCustomValidity('');
  if (ruleEl) {
    ruleEl.classList.remove('invalid');
    ruleEl.textContent = removedInvalid
      ? 'ระบบลบอักขระที่ไม่อนุญาตออกให้อัตโนมัติแล้ว'
      : 'กรอกได้เฉพาะตัวเลข 0–9 และภาษาอังกฤษ A–Z · ถ้าว่าง ระบบจะใช้วันที่นำเข้า';
  }
  return value;
}

function openIssueLookupNotFound(code, source = 'manual') {
  const normalized = normalizeScannedCode(code);
  const looksLikeInventory = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(normalized);
  const title = looksLikeInventory ? 'ไม่พบข้อมูลรหัสนี้ในระบบ' : 'QR Code นี้ไม่ใช่รูปแบบสติ๊กเกอร์ Inventory';
  const body = looksLikeInventory
    ? `<p>กรุณาตรวจสอบว่ารหัสถูกต้อง หรือรายการนี้อาจถูกนำเข้าข้อมูลไม่ครบ/ไม่ถูกต้อง</p><div class="notice">รหัสที่ระบบอ่านได้: <b>${esc(normalized || String(code || '').trim() || '-')}</b></div><ul class="field-hint" style="margin:10px 0 0 18px"><li>รายการนี้อาจยังไม่ถูกนำเข้า</li><li>Lot อาจถูกกรอกผิดรูปแบบ เช่น มีอักขระพิเศษ</li><li>Lot อาจถูกปิดหรือคงเหลือเป็น 0 แล้ว</li></ul>`
    : `<p>กรุณาตรวจสอบว่ากำลังสแกนสติ๊กเกอร์ของระบบนี้อยู่</p><div class="notice">ค่าที่ระบบอ่านได้: <b>${esc(normalized || String(code || '').trim() || '-')}</b></div>`;
  openModal(`<h3>${title}</h3>${body}<form id="retryLookupForm" class="form-grid" style="margin-top:14px"><label>ลองพิมพ์/แก้ไขรหัสอีกครั้ง<input id="retryLookupCode" autocomplete="off" placeholder="เช่น BB020-69020" value="${esc(normalized || String(code || '').trim())}"></label><div class="actions"><button class="primary" type="submit">ค้นหาอีกครั้ง</button><button class="secondary" type="button" id="retryScanBtn">${icon('camera')} สแกนใหม่</button><button class="ghost modal-close" type="button">ปิด</button></div></form>`);
  $('#retryLookupForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const retry = $('#retryLookupCode')?.value || '';
    closeModal();
    resolveIssueCode(retry, 'manual');
  });
  $('#retryScanBtn')?.addEventListener('click', () => {
    closeModal();
    startCameraScanner();
  });
}

async function renderMove(defaultTab = 'receive') {
  page.innerHTML = `<div class="page-head"><div><h2>นำเข้า–นำออก</h2></div></div><div class="tabs move-tabs"><button data-tab="receive">${icon('plus')} นำเข้า</button><button data-tab="issue">${icon('minus')} นำออก</button></div><div id="movePane"></div>`;

  const draw = async tab => {
    moveTab = tab;
    navActive();
    $$('[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
    $('#movePane').innerHTML='<div class="card usage-loading">กำลังโหลดข้อมูลเฉพาะเมนูที่เลือก…</div>';
    if (tab === 'receive') {
      const [rawMats, historyRes, staffRes] = await Promise.all([
        loadMaterials(),
        sb.from('v_transaction_history').select('*').eq('tx_type','RECEIVE').limit(60),
        sb.from('staff_directory').select('email,display_name').eq('active',true).order('display_name')
      ]);
      if(staffRes.error) throw staffRes.error;
      const staffMap=new Map((staffRes.data||[]).map(x=>[x.email,x.display_name]));
      const mats=rawMats.map(m=>({...m,responsible_name:staffMap.get(m.responsible_email)||m.responsible_email||'ยังไม่กำหนด'}));
      const ownerOptions='<option value="">ทุกคน</option>'+(staffRes.data||[]).map(x=>`<option value="${esc(x.email)}">${esc(x.display_name)}</option>`).join('');
      if (historyRes.error) throw historyRes.error;
      const historyRows=historyRes.data || [];
      $('#movePane').innerHTML = `<div class="move-layout"><form id="receiveForm" class="card form-card form-grid"><div class="form-title"><span>${icon('plus')}</span><div><h3>บันทึกนำเข้า</h3></div></div><label>กรองผู้ดูแล<select id="rOwnerFilter">${ownerOptions}</select></label>${materialComboboxMarkup({id:'rMat',label:'วัสดุ',placeholder:'พิมพ์ชื่อวัสดุ เช่น Panel, Papain',materials:mats})}<div class="form-grid two"><label>Lot<input id="rLot" autocomplete="off" autocapitalize="characters" maxlength="60" inputmode="latin" pattern="[A-Za-z0-9]*" placeholder="เช่น 8A145 หรือเว้นว่างเพื่อใช้วันที่นำเข้า"><small id="lotRule" class="field-hint lot-rule">กรอกได้เฉพาะตัวเลข 0–9 และภาษาอังกฤษ A–Z · ถ้าว่าง ระบบจะใช้วันที่นำเข้า</small></label><label>วันหมดอายุ<input id="rExp" type="date"><small class="field-hint">ถ้าไม่มีวันหมดอายุ สามารถเว้นว่างได้</small></label></div><label>จำนวน<input id="rQty" type="number" min="0.01" step="0.01" required inputmode="decimal"></label><button class="primary" type="submit">${icon('plus')} บันทึกนำเข้า</button></form><section class="card history-card"><div class="section-title compact"><div><h3>ประวัตินำเข้าล่าสุด</h3></div><button class="mini ghost" data-route="reports">ดูรายงาน</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>วันเวลา</th><th>สินค้า</th><th>Lot</th><th>จำนวน</th><th>ยอดหลังทำ</th><th>ผู้บันทึก</th></tr></thead><tbody>${transactionRows(historyRows.slice(0,30)) || '<tr><td colspan="6" class="empty">ไม่มีรายการ</td></tr>'}</tbody></table></div></section></div>`;
      setupMaterialCombobox('rMat',mats,{ownerSelectId:'rOwnerFilter',maxResults:20});
      const lotInput=$('#rLot');
      lotInput.addEventListener('input',()=>prepareLotInput(lotInput));
      lotInput.addEventListener('blur',()=>prepareLotInput(lotInput,{autoFillBlank:true,showFallbackHint:true}));
      $('#receiveForm').addEventListener('submit', receive);
    } else {
      const historyRes = await sb.from('v_transaction_history').select('*').eq('tx_type','ISSUE').limit(60);
      if (historyRes.error) throw historyRes.error;
      const historyRows=historyRes.data || [];
      $('#movePane').innerHTML = `<div class="move-layout"><div><section class="card issue-scan-simple"><div class="scan-card simple"><div class="scan-icon">${icon('qr')}</div><div><h3>นำออกด้วย QR Sticker</h3></div></div><button class="primary camera-primary" type="button" data-camera-scan>${icon('camera')} เปิดกล้องสแกน</button><div class="issue-or"><span>หรือ</span></div><form id="manualIssueForm" class="form-grid"><label>พิมพ์รหัส QR / รหัสล็อต<div class="toolbar issue-code-row" style="margin:0"><input id="issueCode" autocomplete="off" placeholder="เช่น BB020-69020" required><button type="submit" class="secondary">ค้นหา</button></div></label></form></section></div><section class="card history-card"><div class="section-title compact"><div><h3>ประวัตินำออกล่าสุด</h3></div><button class="mini ghost" data-route="reports">ดูรายงาน</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>วันเวลา</th><th>สินค้า</th><th>Lot</th><th>จำนวน</th><th>ยอดหลังทำ</th><th>วิธีนำออก</th><th>ผู้บันทึก</th></tr></thead><tbody>${transactionRows(historyRows.slice(0,30), {showIssueMethod:true}) || '<tr><td colspan="7" class="empty">ไม่มีรายการ</td></tr>'}</tbody></table></div></section></div>`;
      $('#manualIssueForm').addEventListener('submit',e=>{e.preventDefault();const code=$('#issueCode').value.trim();if(!code)return toast('กรุณาพิมพ์รหัส QR หรือรหัสล็อต',true);resolveIssueCode(code);});
    }
  };
  $$('[data-tab]').forEach(b => b.addEventListener('click', () => draw(b.dataset.tab).catch(e=>{ $('#movePane').innerHTML=`<div class="card notice">${esc(errMsg(e))}</div>`; })));
  await draw(defaultTab === 'issue' ? 'issue' : 'receive');
}

async function receive(e) {
  e.preventDefault();
  const materialCode=$('#rMat').value;
  if (!materialCode) {
    $('#rMatSearch')?.focus();
    return toast('กรุณาพิมพ์ชื่อและเลือกวัสดุจากรายการ', true);
  }
  const lotInput = $('#rLot');
  const rawLotBefore = String(lotInput.value || '').trim();
  const lot = prepareLotInput(lotInput, {autoFillBlank:true,showFallbackHint:true});
  if (!lot || !/^[A-Z0-9]+$/.test(lot)) {
    lotInput.focus();
    return toast('Lot ต้องมีเฉพาะตัวเลข 0–9 และ/หรือภาษาอังกฤษ A–Z เท่านั้น', true);
  }
  if (!rawLotBefore) toast(`ไม่ได้กรอก Lot ระบบจึงใช้วันที่นำเข้า ${lot} เป็น Lot อัตโนมัติ`);
  const btn = e.submitter;
  btn.disabled = true;
  const {data, error} = await sb.rpc('fn_receive_stock', {
    p_material_code:materialCode,
    p_lot_no:lot,
    p_expiry_date:$('#rExp').value || null,
    p_quantity:Number($('#rQty').value)
  });
  btn.disabled = false;
  if (error) return toast(errMsg(error), true);
  materialsCache = [];
  stockCache = []; scanLotsCache=[]; scanLotsLoadedAt=0;
  inventorySummaryCache=[];
  toast('รับเข้าสต๊อกแล้ว');
  const row = Array.isArray(data) ? data[0] : data;
  openModal(`<h3>รับเข้าเรียบร้อย</h3><p class="muted">ยอดใหม่ ${qty(row?.quantity_after)}</p><div class="actions"><button class="primary" data-print="${esc(row?.lot_id || '')}">${icon('print')} พิมพ์ QR Sticker</button><button class="secondary modal-close">ปิด</button></div>`);
}

function findLotByCode(raw, lots = stockCache) {
  let value = String(raw || '').trim();
  if (!value) return null;
  try {
    const u = new URL(value);
    value = u.searchParams.get('issue') || u.searchParams.get('lot') || u.searchParams.get('code') || value;
  } catch (_) {}
  try { value = decodeURIComponent(value); } catch (_) {}
  value = value.replace(/^INV[:|]/i, '').trim();
  const norm = normalizeScannedCode(value);
  const compact = norm.replace(/[^A-Z0-9]/g, '');
  return lots.find(l => {
    const aliases = [...pgArray(l.legacy_codes), ...pgArray(l.legacy_lot_keys)];
    const keys = [l.lot_id, lotKey(l), `${l.material_code}-${l.lot_no}`, `${l.material_code}|${l.lot_no}`, ...aliases];
    return keys.some(k => {
      const keyNorm = normalizeScannedCode(k);
      return keyNorm === norm || keyNorm.replace(/[^A-Z0-9]/g, '') === compact;
    });
  }) || null;
}

async function resolveIssueCode(code, source = 'manual') {
  const lots = await getLots(true);
  const l = findLotByCode(code, lots);
  if (!l) return openIssueLookupNotFound(code, source);
  if (isExpired(l)) return toast('Lot นี้หมดอายุแล้ว ให้ยืนยันนำออกจากพื้นที่ในเมนูตรวจวันศุกร์', true);
  openIssueModal(l, source);
}

function openIssueModal(l, source = 'manual') {
  if (!l || Number(l.balance) <= 0) return toast('Lot นี้ไม่มียอดคงเหลือ', true);
  if (isExpired(l)) return toast('Lot นี้หมดอายุแล้ว ให้ยืนยันนำออกจากพื้นที่ในเมนูตรวจวันศุกร์', true);
  const issueMethod = source === 'scan' ? 'QR_SCAN' : 'MANUAL_ENTRY';
  openModal(`<h3>ยืนยันนำออก</h3><div class="selected-lot"><div><strong>${esc(l.material_name)}</strong><small>${esc(lotKey(l))} · EXP ${d(l.expiry_date)}</small></div><span class="badge info">เหลือ ${qty(l.balance)} ${esc(l.unit)}</span></div><div class="notice">วิธีนำออก: <b>${esc(issueMethodLabel(issueMethod))}</b><br>ระบบล็อกให้ตัดออกครั้งละ 1 หน่วยต่อ 1 ครั้ง</div><form id="quickIssueForm" class="form-grid" style="margin-top:15px"><label>หมายเหตุ<textarea id="quickIssueReason" rows="2" placeholder="ระบุเมื่อต้องการ"></textarea></label><button class="primary" type="submit">${icon('minus')} ยืนยันนำออก 1 หน่วย</button></form>`);
  $('#quickIssueForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    const {error} = await sb.rpc('fn_issue_stock', {
      p_lot_id:l.lot_id,
      p_quantity:1,
      p_reason_detail:$('#quickIssueReason').value.trim() || null,
      p_issue_method:issueMethod
    });
    btn.disabled = false;
    if (error) return toast(errMsg(error), true);
    closeModal();
    stockCache = []; scanLotsCache=[]; scanLotsLoadedAt=0;
    toast('บันทึกนำออก 1 หน่วยแล้ว');
    navigate(route === 'home' ? 'home' : 'stock');
  });
}

async function openPendingIssue() {
  const code = pendingIssueCode;
  pendingIssueCode = null;
  try {
    const u = new URL(location.href);
    u.searchParams.delete('issue');
    u.searchParams.delete('lot');
    history.replaceState({}, '', u.pathname + u.search + u.hash);
  } catch (_) {}
  if (code) await resolveIssueCode(code, 'scan');
}

async function startCameraScanner(mode = 'issue') {
  const inspectMode = mode === 'inspect';
  const resolveCode = inspectMode ? resolveStockCheckCode : resolveIssueCode;
  const submitCode = (value, source = 'manual') => inspectMode ? resolveCode(value) : resolveCode(value, source);
  const title = inspectMode ? 'สแกนตรวจ Lot' : 'สแกน QR Sticker';
  const description = inspectMode ? 'หันกล้องไปที่ QR เพื่อดูยอดคงเหลือและบันทึกผลตรวจ' : 'หันกล้องหลังไปที่ QR และให้อยู่ภายในกรอบ';
  if (!navigator.mediaDevices?.getUserMedia) {
    openModal(`<h3>อุปกรณ์นี้เปิดกล้องไม่ได้</h3><p>กรุณาเปิดแอปผ่าน Safari หรือ Chrome และตรวจว่าเว็บไซต์ได้รับอนุญาตให้ใช้กล้อง</p><form id="manualScanForm" class="form-grid"><label>พิมพ์รหัส QR<input id="manualScanCode" placeholder="เช่น BB319-09062026" autocomplete="off"></label><button class="primary" type="submit">${inspectMode?'ตรวจสอบ Lot':'ค้นหา Lot'}</button></form>`);
    $('#manualScanForm').addEventListener('submit', e => { e.preventDefault(); const code = $('#manualScanCode').value; closeModal(); submitCode(code, 'manual'); });
    return;
  }

  openModal(`<div class="scanner-head"><div><h3>${title}</h3><p>${description}</p></div><button class="icon-button modal-close" type="button" aria-label="ปิด">×</button></div><div class="scan-video-wrap"><video id="scanVideo" autoplay playsinline muted></video><canvas id="scanCanvas" hidden></canvas><div class="scan-frame"></div><div id="scanStatus" class="scan-status">กำลังเปิดกล้อง…</div></div><p class="muted small">รองรับ QR Sticker ใหม่ รหัสเดิม และรหัส Lot เดิม</p><form id="manualScanForm" class="scanner-manual form-grid"><label>หรือพิมพ์รหัส QR<input id="manualScanCode" placeholder="เช่น BB319-09062026" autocomplete="off"></label><button class="secondary" type="submit">${inspectMode?'ตรวจสอบ Lot':'ค้นหา Lot'}</button></form>`);
  $('#manualScanForm').addEventListener('submit', e => { e.preventDefault(); const code = $('#manualScanCode').value; closeModal(); submitCode(code, 'manual'); });

  const status = $('#scanStatus');
  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{exact:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
    } catch (_) {
      stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
    }
    scannerStream = stream;
    const video = $('#scanVideo');
    const canvas = $('#scanCanvas');
    const ctx = canvas.getContext('2d', {willReadFrequently:true});
    video.srcObject = scannerStream;
    await video.play();

    let detector = null;
    if ('BarcodeDetector' in window) {
      try { detector = new BarcodeDetector({formats:['qr_code']}); } catch (_) {}
    }
    const decoderReady = detector ? true : await ensureQrDecoder();
    if (!detector && !decoderReady) throw new Error('โหลดตัวอ่าน QR ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่');
    status.textContent = 'พร้อมสแกน QR';

    let busy = false;
    const finish = value => {
      if (!value) return false;
      stopScanner();
      closeModal();
      submitCode(value, 'scan');
      return true;
    };
    const scan = async () => {
      if (!scannerStream || $('#modal').classList.contains('hidden')) return;
      if (!busy && video.readyState >= 2) {
        busy = true;
        try {
          if (detector) {
            const codes = await detector.detect(video);
            if (finish(codes?.[0]?.rawValue)) return;
          } else if (typeof window.jsQR === 'function') {
            const sourceW = video.videoWidth || 640;
            const sourceH = video.videoHeight || 480;
            const scale = Math.min(1, 1280 / Math.max(sourceW, sourceH));
            canvas.width = Math.max(480, Math.round(sourceW * scale));
            canvas.height = Math.max(360, Math.round(sourceH * scale));
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            let image = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let result = window.jsQR(image.data, image.width, image.height, {inversionAttempts:'attemptBoth'});
            if (!result) {
              const cropX = Math.round(canvas.width * 0.12);
              const cropY = Math.round(canvas.height * 0.18);
              const cropW = Math.round(canvas.width * 0.76);
              const cropH = Math.round(canvas.height * 0.64);
              image = ctx.getImageData(cropX, cropY, cropW, cropH);
              result = window.jsQR(image.data, image.width, image.height, {inversionAttempts:'attemptBoth'});
            }
            if (finish(result?.data)) return;
          }
        } catch (_) {
        } finally {
          busy = false;
        }
      }
      scannerTimer = setTimeout(scan, 160);
    };
    scan();
  } catch (e) {
    stopScanner();
    const name = e?.name || '';
    const message = name === 'NotAllowedError'
      ? 'ยังไม่ได้อนุญาตให้ใช้กล้อง กรุณาเปิดการอนุญาตกล้องของ Safari/Chrome แล้วกดลองใหม่'
      : name === 'NotFoundError'
        ? 'ไม่พบกล้องบนอุปกรณ์นี้'
        : name === 'NotReadableError'
          ? 'กล้องอาจถูกแอปอื่นใช้งานอยู่ กรุณาปิดแอปกล้องแล้วลองใหม่'
          : errMsg(e);
    $('#modalBody').innerHTML = `<h3>เปิดกล้องไม่สำเร็จ</h3><p>${esc(message)}</p><form id="manualScanForm" class="form-grid"><label>พิมพ์รหัส QR<input id="manualScanCode" placeholder="เช่น BB319-09062026" autocomplete="off"></label><button class="primary" type="submit">${inspectMode?'ตรวจสอบ Lot':'ค้นหา Lot'}</button></form>`;
    $('#manualScanForm').addEventListener('submit', ev => { ev.preventDefault(); const code = $('#manualScanCode').value; closeModal(); submitCode(code, 'manual'); });
  }
}

function stopScanner() {
  if (scannerTimer) clearTimeout(scannerTimer);
  scannerTimer = null;
  if (scannerStream) scannerStream.getTracks().forEach(t => t.stop());
  scannerStream = null;
}

function canHandleItem(x) {
  return isAdminMode() || x.responsible_email === profile.email;
}

function weeklyItemCard(x) {
  const expired = requiresExpiryConfirmation(x) && x.checked_at == null;
  const resultText = x.result === 'MATCHED' ? 'ตรง' : x.result === 'ADJUSTED' ? 'ปรับแล้ว' : x.result === 'EXPIRED_REMOVED' ? 'นำหมดอายุออกแล้ว' : '';
  const resultClass = x.result === 'MATCHED' ? 'ok' : x.result === 'EXPIRED_REMOVED' ? 'danger' : 'warn';
  let action = '';
  if (x.checked_at) action = `<span class="badge ${resultClass}">${resultText}</span>`;
  else if (!canHandleItem(x)) action = `<span class="badge">รอ ${esc(x.responsible_name || 'ผู้ดูแล')}</span>`;
  else if (expired) action = `<button class="mini danger" data-expired-remove="${esc(x.item_id)}">ยืนยันนำออก</button>`;
  else action = `<button class="mini" data-check="${esc(x.item_id)}">ตรวจ</button>`;
  return `<div class="card check-card ${x.checked_at ? (x.result === 'ADJUSTED' ? 'mismatch' : x.result === 'EXPIRED_REMOVED' ? 'expired-done' : 'checked') : expired ? 'expired-card' : ''}"><div class="check-info"><div><strong>${esc(x.material_name)}</strong><div class="lot-meta">${esc(lotKey(x))} · ระบบ ${qty(x.current_balance)} ${esc(x.unit)} · EXP ${d(x.expiry_date)}</div><div class="lot-meta">ผู้ดูแล: ${esc(x.responsible_name || '-')}</div>${expired ? '<div class="expired-callout">หมดอายุแล้ว: ไม่ต้องนับ ให้ตรวจว่านำออกจากพื้นที่จริงแล้ว</div>' : ''}${x.checked_at ? `<div class="lot-meta">ดำเนินการโดย ${esc(x.checked_by_name || x.checked_by_email)} · ${dt(x.checked_at)}</div>` : ''}</div>${action}</div></div>`;
}

async function renderWeekly() {
  const check = await ensureCheck();
  if (!check) { page.innerHTML = '<div class="card empty">ยังไม่มีรอบตรวจ</div>'; return; }
  const [{data, error}, staffRes] = await Promise.all([
    sb.from('v_weekly_check_items').select('*').eq('check_id', check.id).order('material_code').order('lot_no'),
    sb.from('staff_directory').select('*').eq('active', true).order('display_name')
  ]);
  if (error) throw error;
  if (staffRes.error) throw staffRes.error;
  const items = (data || []).filter(x => x.checked_at || !isExpired(x) || requiresExpiryConfirmation(x));
  const done = items.filter(x => x.checked_at).length;
  const pct = items.length ? Math.round(done * 100 / items.length) : 100;
  const expiredPending = items.filter(x => !x.checked_at && requiresExpiryConfirmation(x)).length;
  const ownerSet = new Map();
  items.forEach(i => { if (i.responsible_email && !ownerSet.has(i.responsible_email)) ownerSet.set(i.responsible_email, i.responsible_name || i.responsible_email); });
  const ownerSelect = ['<option value="mine">ของฉัน</option>', '<option value="all">ทุกคน</option>'].concat([...ownerSet.entries()].sort((a,b)=>String(a[1]).localeCompare(String(b[1]), 'th')).map(([email, name]) => `<option value="${esc(email)}">${esc(name)}</option>`)).join('');

  page.innerHTML = `<div class="page-head"><div><h2>ตรวจสต๊อกวันศุกร์</h2><p class="muted small">รอบวันที่ ${d(check.week_friday)}</p></div><button class="mini ghost" data-route="weekly-status">${icon('user')} สถานะผู้ตรวจ</button></div>
  <section class="card weekly-header"><div class="weekly-ring small-ring" style="--pct:${pct}"><div><strong>${pct}%</strong><span>${done}/${items.length}</span></div></div><div><h3>ความคืบหน้า</h3><p class="muted">ยังไม่ตรวจ ${items.length-done} Lot · หมดอายุรอยืนยัน ${expiredPending} Lot</p></div></section>
  <div class="weekly-tools"><label>กรองเจ้าหน้าที่<select id="weeklyOwnerFilter">${ownerSelect}</select></label><div class="filters horizontal-scroller" style="margin-bottom:0"><button class="chip active" data-wf="pending">ยังไม่ตรวจ</button><button class="chip" data-wf="mine">งานของฉัน</button><button class="chip" data-wf="expired">หมดอายุ</button><button class="chip" data-wf="mismatch">ไม่ตรง</button><button class="chip" data-wf="done">ตรวจแล้ว</button><button class="chip" data-wf="all">ทั้งหมด</button></div></div><div id="checkList" class="list"></div>${check.status !== 'COMPLETED' && isAdminMode() ? '<button id="completeCheck" class="primary wide-action">เสร็จสิ้นและปิดรอบตรวจ</button>' : ''}`;

  let f = 'pending';
  const ownerFilter = $('#weeklyOwnerFilter');
  ownerFilter.value = isAdminMode() ? 'all' : 'mine';
  const draw = () => {
    let arr = items;
    const owner = ownerFilter.value;
    if (owner === 'mine') arr = arr.filter(x => x.responsible_email === profile.email || x.checked_by_email === profile.email);
    else if (owner !== 'all') arr = arr.filter(x => x.responsible_email === owner);
    if (f === 'mine') arr = arr.filter(x => x.responsible_email === profile.email || x.checked_by_email === profile.email);
    if (f === 'pending') arr = arr.filter(x => !x.checked_at);
    if (f === 'expired') arr = arr.filter(x => requiresExpiryConfirmation(x) || x.result === 'EXPIRED_REMOVED');
    if (f === 'mismatch') arr = arr.filter(x => x.result === 'ADJUSTED');
    if (f === 'done') arr = arr.filter(x => x.checked_at);
    $('#checkList').innerHTML = arr.map(weeklyItemCard).join('') || '<div class="card empty">ไม่มีรายการตามตัวกรองนี้</div>';
  };
  ownerFilter.addEventListener('change', draw);
  $$('[data-wf]').forEach(b => b.addEventListener('click', () => { f=b.dataset.wf; $$('[data-wf]').forEach(x=>x.classList.toggle('active',x===b)); draw(); }));
  draw();
  if ($('#completeCheck')) $('#completeCheck').onclick = async () => {
    const {error} = await sb.rpc('fn_complete_weekly_check', {p_check_id:check.id, p_acting_mode:actingMode});
    if (error) return toast(errMsg(error), true);
    toast('ปิดรอบตรวจสต๊อกแล้ว'); renderWeekly();
  };
  window._weeklyItems = items;
}

async function renderWeeklyStatus() {
  const end=new Date();
  const start=new Date(end); start.setDate(start.getDate()-84);
  page.innerHTML=`<div class="page-head"><div><h2>สถานะผู้ตรวจวันศุกร์</h2></div><button class="mini ghost" data-route="weekly">กลับไปตรวจสต๊อก</button></div><form id="weeklyStatusForm" class="card weekly-status-filter"><label>ตั้งแต่วันที่<input id="weeklyStatusFrom" type="date" value="${dateInputValue(start)}"></label><label>ถึงวันที่<input id="weeklyStatusTo" type="date" value="${dateInputValue(end)}"></label><button class="primary" type="submit">แสดงผล</button></form><div id="weeklyStatusResult"></div>`;
  const load=async()=>{
    const from=$('#weeklyStatusFrom').value,to=$('#weeklyStatusTo').value;
    if(!from||!to||from>to)return toast('ช่วงวันที่ไม่ถูกต้อง',true);
    $('#weeklyStatusResult').innerHTML='<div class="card usage-loading">กำลังโหลดสถานะผู้ตรวจ…</div>';
    const {data,error}=await sb.from('v_weekly_staff_status').select('*').gte('week_friday',from).lte('week_friday',to).order('week_friday',{ascending:false});
    if(error){$('#weeklyStatusResult').innerHTML=`<div class="card notice">${esc(errMsg(error))}</div>`;return;}
    const rows=data||[];
    const people=new Map(),weeks=new Map();
    rows.forEach(r=>{
      const email=r.assigned_email||'unassigned';
      if(!people.has(email))people.set(email,{name:r.assigned_name||'ยังไม่กำหนด',rounds:0,done:0,missed:0,pending:0,delegated:0});
      const p=people.get(email);p.rounds++;p.pending+=Number(r.pending_items||0);p.delegated+=Number(r.checked_by_other_items||0);if(Number(r.pending_items||0)>0)p.missed++;else p.done++;
      const week=r.week_friday;if(!weeks.has(week))weeks.set(week,[]);weeks.get(week).push(r);
    });
    const peopleHtml=[...people.values()].sort((a,b)=>b.missed-a.missed||a.name.localeCompare(b.name,'th')).map(p=>`<article><strong>${esc(p.name)}</strong><span>ครบ ${p.done}/${p.rounds} สัปดาห์</span><em class="${p.missed?'danger-text':'ok-text'}">ไม่ครบ ${p.missed}</em>${p.delegated?`<small>มีผู้ตรวจแทน ${p.delegated} Lot</small>`:''}</article>`).join('');
    const weekHtml=[...weeks.entries()].map(([week,items])=>{const pending=items.filter(x=>Number(x.pending_items||0)>0),done=items.filter(x=>Number(x.pending_items||0)===0&&Number(x.total_items||0)>0);return `<details class="weekly-round-card"><summary><strong>ศุกร์ ${d(week)}</strong><span>${done.length}/${items.length} คนครบ</span></summary><div class="weekly-round-columns"><div><h4>ยังไม่ครบ (${pending.length})</h4>${pending.map(x=>`<p><strong>${esc(x.assigned_name)}</strong><span>เหลือ ${qty(x.pending_items)} Lot</span></p>`).join('')||'<p class="ok-text">ทุกคนตรวจครบ</p>'}</div><div><h4>ตรวจครบแล้ว (${done.length})</h4>${done.map(x=>`<p><strong>${esc(x.assigned_name)}</strong><span>${qty(x.checked_items)}/${qty(x.total_items)} Lot</span></p>`).join('')||'<p class="muted">ยังไม่มี</p>'}</div></div></details>`;}).join('');
    $('#weeklyStatusResult').innerHTML=`<section class="card"><div class="section-title compact"><h3>สรุปตามเจ้าหน้าที่</h3><span class="badge info">${weeks.size} สัปดาห์</span></div><div class="weekly-staff-summary-grid">${peopleHtml||'<div class="empty">ไม่มีข้อมูล</div>'}</div></section><section class="weekly-round-list"><div class="section-title"><h3>รายละเอียดแต่ละวันศุกร์</h3></div>${weekHtml||'<div class="card empty">ไม่มีข้อมูลในช่วงวันที่เลือก</div>'}</section>`;
  };
  $('#weeklyStatusForm').addEventListener('submit',e=>{e.preventDefault();load();});
  await load();
}

function openCheck(id) {
  const x = (window._weeklyItems || []).find(i => i.item_id === id);
  if (!x) return;
  if (!canHandleItem(x)) return toast('รายการนี้เป็นความรับผิดชอบของ ' + (x.responsible_name || x.responsible_email), true);
  if (isExpired(x)) return openExpiredRemoval(id);
  openModal(`<h3>${esc(x.material_name)}</h3><p class="muted">${esc(lotKey(x))} · ยอดในระบบ ${qty(x.current_balance)} ${esc(x.unit)}</p><div class="check-adjustment-guide">${icon('check')}<div><strong>กรอกจำนวนที่นับได้จริง</strong><span>หากไม่เท่ากับยอดในระบบ ระบบจะปรับยอดคงเหลือให้เท่ากับจำนวนที่กรอก พร้อมเก็บชื่อผู้ตรวจและเหตุผลไว้ในประวัติ</span></div></div><form id="checkForm" class="form-grid"><label>จำนวนที่นับได้จริง<input id="actualQty" type="number" min="0" step="0.01" value="${Number(x.current_balance)}" required inputmode="decimal"></label><div id="adjustmentPreview" class="adjustment-preview matched">ยอดตรงกับระบบ ยังไม่มีการปรับจำนวน</div><div id="reasonFields" class="form-grid hidden"><label>เหตุผล<select id="reasonCode"><option value="">เลือกเหตุผล</option><option>นำออกแล้วไม่ได้บันทึก</option><option>รับเข้าหรือนำออกผิดจำนวน</option><option>สูญหายหรือหาไม่พบ</option><option>ชำรุด</option><option>นับครั้งก่อนผิด</option><option>Lot หรือสติ๊กเกอร์ไม่ตรง</option><option>อื่น ๆ</option></select></label><label>รายละเอียด<textarea id="reasonDetail" rows="3"></textarea></label></div><button class="primary" type="submit">บันทึกผลตรวจ</button></form>`);
  const toggle = () => {
    const actual=Number($('#actualQty').value);
    const current=Number(x.current_balance);
    const diff=actual-current;
    $('#reasonFields').classList.toggle('hidden', diff===0);
    const preview=$('#adjustmentPreview');
    if (diff===0) {
      preview.className='adjustment-preview matched';
      preview.textContent='ยอดตรงกับระบบ ยังไม่มีการปรับจำนวน';
    } else {
      preview.className='adjustment-preview changed';
      preview.textContent=`ระบบจะปรับยอดจาก ${qty(current)} เป็น ${qty(actual)} ${x.unit || ''} (${diff>0?'เพิ่ม':'ลด'} ${qty(Math.abs(diff))})`;
    }
  };
  $('#actualQty').addEventListener('input', toggle);
  toggle();
  $('#checkForm').addEventListener('submit', async e => {
    e.preventDefault();
    const actual = Number($('#actualQty').value);
    const diff = actual !== Number(x.current_balance);
    if (diff && !$('#reasonCode').value) return toast('กรุณาเลือกเหตุผล', true);
    const {error} = await sb.rpc('fn_save_stock_check', {
      p_item_id:id,
      p_actual_qty:actual,
      p_reason_code:diff ? $('#reasonCode').value : null,
      p_reason_detail:diff ? $('#reasonDetail').value.trim() || null : null,
      p_acting_mode:actingMode
    });
    if (error) return toast(errMsg(error), true);
    closeModal();
    stockCache = []; scanLotsCache=[]; scanLotsLoadedAt=0;
    inventorySummaryCache=[];
    toast(diff ? `ปรับยอดคงเหลือเป็น ${qty(actual)} ${x.unit || ''} แล้ว` : 'บันทึกผลตรวจแล้ว ยอดตรงกับระบบ');
    route === 'scan-stock' ? renderScanStock() : renderWeekly();
  });
}

function openExpiredRemoval(id) {
  const x = (window._weeklyItems || []).find(i => i.item_id === id);
  if (!x) return;
  if (!canHandleItem(x)) return toast('รายการนี้เป็นความรับผิดชอบของ ' + (x.responsible_name || x.responsible_email), true);
  openModal(`<h3>ยืนยันนำ Lot หมดอายุออกจากพื้นที่</h3><div class="expired-confirm-card"><strong>${esc(x.material_name)}</strong><span>${esc(lotKey(x))}</span><span>EXP ${d(x.expiry_date)} · คงเหลือในระบบ ${qty(x.current_balance)} ${esc(x.unit)}</span></div><form id="expiredForm" class="form-grid"><label class="confirm-check"><input id="expiredConfirm" type="checkbox" required><span>ตรวจแล้วว่า Lot นี้ถูกนำออกจากชั้น/ตู้/พื้นที่ใช้งานจริง</span></label><label>หมายเหตุ<textarea id="expiredNote" rows="3" placeholder="เช่น นำไปจุดพักของหมดอายุแล้ว"></textarea></label><p class="notice">เมื่อยืนยัน ระบบจะตัดยอดเป็น 0 ปิด Lot และสัปดาห์หน้าจะไม่ต้องตรวจซ้ำ</p><button class="danger" type="submit">${icon('check')} ยืนยันนำออกจากพื้นที่แล้ว</button></form>`);
  $('#expiredForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!$('#expiredConfirm').checked) return toast('กรุณายืนยันว่าได้นำออกจากพื้นที่จริงแล้ว', true);
    const btn = e.submitter;
    btn.disabled = true;
    const {error} = await sb.rpc('fn_confirm_expired_removal', {
      p_item_id:id,
      p_note:$('#expiredNote').value.trim() || null,
      p_acting_mode:actingMode
    });
    btn.disabled = false;
    if (error) return toast(errMsg(error), true);
    closeModal();
    stockCache = []; scanLotsCache=[]; scanLotsLoadedAt=0;
    toast('นำ Lot หมดอายุออกจากสต๊อกแล้ว สัปดาห์หน้าจะไม่แสดงซ้ำ');
    route === 'scan-stock' ? renderScanStock() : renderWeekly();
  });
}

async function renderActivity() {
  page.innerHTML = `<div class="page-head"><div><h2>ประวัติการทำรายการ</h2><p class="muted small">เลือกประเภทก่อน ระบบจึงจะโหลดรายการล่าสุด</p></div></div><section class="card lazy-filter-card"><label>ประเภทกิจกรรม<select id="activityType"><option value="">กรุณาเลือกประเภท</option><option value="all">ทั้งหมด</option><option value="receive">นำเข้า</option><option value="issue">นำออก</option><option value="print">พิมพ์ QR Sticker</option><option value="check">ตรวจสต๊อก</option><option value="expired">ของหมดอายุ</option></select></label><div class="search-box">${icon('search')}<input id="activitySearch" placeholder="ค้นหาในรายการที่โหลด" disabled></div></section><div id="activityList"><div class="card select-first-state">${icon('history')}<div><strong>กรุณาเลือกประเภทกิจกรรม</strong><span>ยังไม่มีการโหลดประวัติ</span></div></div></div>`;
  let loaded=[];
  const draw=()=>{const s=$('#activitySearch').value.toLowerCase();const arr=loaded.filter(a=>!s||JSON.stringify(a).toLowerCase().includes(s));$('#activityList').innerHTML=arr.map(a=>`<div class="card">${activityCard(a)}</div>`).join('')||'<div class="card empty">ไม่พบกิจกรรม</div>';};
  const load=async()=>{
    const type=$('#activityType').value;
    if(!type){loaded=[];$('#activitySearch').disabled=true;$('#activityList').innerHTML='<div class="card select-first-state">'+icon('history')+'<div><strong>กรุณาเลือกประเภทกิจกรรม</strong><span>ยังไม่มีการโหลดประวัติ</span></div></div>';return;}
    $('#activityList').innerHTML='<div class="card usage-loading">กำลังโหลดกิจกรรมล่าสุด…</div>';
    try { await loadActivityMaterials(); } catch (_) {}
    let q=sb.from('v_audit_activity').select('*');
    if(type==='receive')q=q.eq('action','RECEIVE');
    else if(type==='issue')q=q.eq('action','ISSUE');
    else if(type==='print')q=q.eq('action','LABEL_PRINT');
    else if(type==='expired')q=q.in('action',['EXPIRED_REMOVED','AUTO_EXPIRED']);
    else if(type==='check')q=q.in('action',['STOCK_CHECK_MATCHED','STOCK_CHECK_ADJUSTED','WEEKLY_CHECK_COMPLETED']);
    const {data,error}=await q.limit(300);
    if(error){$('#activityList').innerHTML=`<div class="card notice">${esc(errMsg(error))}</div>`;return;}
    loaded=data||[];$('#activitySearch').disabled=false;draw();
  };
  $('#activityType').addEventListener('change',load);
  $('#activitySearch').addEventListener('input',draw);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

function saveCsv(filename, rows) {
  const text = '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([text], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportReport(kind) {
  const stamp = new Date().toISOString().slice(0,10);
  if (kind === 'stock') {
    const rows = window._reportStock || [];
    saveCsv(`CNMI_Inventory_Stock_${stamp}.csv`, [['รหัสวัสดุ','ชื่อวัสดุ','Lot','วันหมดอายุ','คงเหลือ','หน่วย','ผู้ดูแล','สถานะ','รหัสเดิมที่สแกนได้'], ...rows.map(x => [x.material_code,x.material_name,x.lot_no,x.expiry_date || '',x.balance,x.unit,x.responsible_name || '',isExpired(x)?'หมดอายุรอนำออก':'ใช้งาน',pgArray(x.legacy_lot_keys).join(' | ')])]);
  } else {
    const rows = (window._reportRows || []).filter(x => kind === 'receive' ? x.tx_type === 'RECEIVE' : kind === 'issue' ? x.tx_type === 'ISSUE' : x.tx_type === 'EXPIRED');
    const header = ['วันเวลา','ประเภท','รหัสหลัก','รหัสเดิม','ชื่อวัสดุ','Lot','วันหมดอายุ','จำนวนเปลี่ยนแปลง','ยอดก่อน','ยอดหลัง','หน่วย'];
    if (kind === 'issue') header.push('วิธีนำออก');
    header.push('ผู้บันทึก','เหตุผล');
    const dataRows = rows.map(x => {
      const row = [x.created_at,x.tx_type,x.canonical_code,x.legacy_material_code || '',x.material_name,x.lot_no,x.expiry_date || '',x.quantity_delta,x.quantity_before,x.quantity_after,x.unit];
      if (kind === 'issue') row.push(issueMethodLabel(x.issue_method));
      row.push(x.created_by_name || x.created_by_email || 'SYSTEM',x.reason_detail || x.reason_code || '');
      return row;
    });
    saveCsv(`CNMI_Inventory_${kind}_${stamp}.csv`, [header, ...dataRows]);
  }
  toast('ส่งออก CSV แล้ว');
}

async function renderReports(defaultTab = '') {
  page.innerHTML = `<div class="page-head"><div><h2>รายงาน & ส่งออก</h2><p class="muted small">เลือกประเภทรายงานก่อน ระบบจึงจะโหลดข้อมูล</p></div></div><div class="tabs report-tabs"><button data-report-tab="receive">นำเข้า</button><button data-report-tab="issue">นำออก</button><button data-report-tab="expired">หมดอายุ</button><button data-report-tab="stock">สต๊อกคงเหลือ</button></div><div id="reportPane"><div class="card select-first-state">${icon('download')}<div><strong>กรุณาเลือกประเภทรายงาน</strong><span>ยังไม่มีการโหลดข้อมูล</span></div></div></div>`;
  const draw = async tab => {
    reportTab = tab;
    $$('[data-report-tab]').forEach(x => x.classList.toggle('active', x.dataset.reportTab === tab));
    $('#reportPane').innerHTML='<div class="card usage-loading">กำลังโหลดรายงานที่เลือก…</div>';
    if (tab === 'stock') {
      const lots=await getLots(true);
      window._reportStock=lots;
      $('#reportPane').innerHTML = `<div class="report-actions"><span class="muted">แสดง ${lots.length} Lot ที่ยัง Active</span><button class="primary" data-export-report="stock">${icon('download')} ส่งออกสต๊อก CSV</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>สินค้า</th><th>Lot</th><th>คงเหลือ</th><th>EXP</th><th>ผู้ดูแล</th><th>สถานะ</th></tr></thead><tbody>${lots.map(x => `<tr><td><strong>${esc(x.material_name)}</strong></td><td>${esc(lotKey(x))}</td><td>${qty(x.balance)} ${esc(x.unit)}</td><td>${d(x.expiry_date)}</td><td>${esc(x.responsible_name || '-')}</td><td>${statusBadge(x)}</td></tr>`).join('')}</tbody></table></div>`;
      return;
    }
    const type = tab === 'receive' ? 'RECEIVE' : tab === 'issue' ? 'ISSUE' : 'EXPIRED';
    const {data,error}=await sb.from('v_transaction_history').select('*').eq('tx_type',type).limit(1500);
    if(error)throw error;
    const filtered=data||[];
    window._reportRows=filtered;
    const showIssueMethod = tab === 'issue';
    $('#reportPane').innerHTML = `<div class="report-actions"><span class="muted">แสดง ${filtered.length} รายการล่าสุด</span><button class="primary" data-export-report="${tab}">${icon('download')} ส่งออก CSV</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>วันเวลา</th><th>สินค้า</th><th>Lot</th><th>จำนวน</th><th>ยอดหลังทำ</th>${showIssueMethod ? '<th>วิธีนำออก</th>' : ''}<th>ผู้บันทึก</th></tr></thead><tbody>${transactionRows(filtered, {showIssueMethod}) || `<tr><td colspan="${showIssueMethod ? 7 : 6}" class="empty">ไม่มีรายการ</td></tr>`}</tbody></table></div>`;
  };
  $$('[data-report-tab]').forEach(b => b.addEventListener('click', () => draw(b.dataset.reportTab).catch(e=>{$('#reportPane').innerHTML=`<div class="card notice">${esc(errMsg(e))}</div>`;})));
  if(defaultTab) await draw(defaultTab);
}

async function renderAdmin() {
  if (!isAdminMode()) { page.innerHTML = '<div class="card notice">สลับเป็นโหมดผู้ดูแลระบบก่อน</div>'; return; }
  const [{data:m, error:me}, {data:s, error:se}] = await Promise.all([
    sb.from('materials').select('*').eq('is_main', true).eq('status','Active').order('code'),
    sb.from('staff_directory').select('*').order('display_name')
  ]);
  if (me || se) throw me || se;
  materialsCache = [];
  window._adminMaterials = m || [];
  window._adminStaff = s || [];
  page.innerHTML = `<div class="page-head"><div><h2>ตั้งค่าผู้ดูแลระบบ</h2><p class="muted small">เปลี่ยนคนดูแลวัสดุได้ตลอด และกำหนดสิทธิ์ผู้ใช้</p></div><span class="badge info">โหมด Admin</span></div><section class="admin-note"><strong>การทำงาน 2 โหมด</strong><p>บัญชี Admin สามารถสลับเป็น “เจ้าหน้าที่” เพื่อทำงานเหมือนทุกคน หรือ “ผู้ดูแลระบบ” เมื่อต้องตั้งค่าและดูงานรวม</p></section><div class="section-title"><h3>ผู้ใช้งาน</h3></div><div class="table-wrap"><table class="data-table"><thead><tr><th>ชื่อ</th><th>อีเมล</th><th>สิทธิ์บัญชี</th></tr></thead><tbody>${(s || []).map(x => `<tr><td>${esc(x.display_name)}</td><td>${esc(x.email)}</td><td><select data-role-email="${esc(x.email)}"><option value="staff" ${x.role === 'staff' ? 'selected' : ''}>เจ้าหน้าที่</option><option value="admin" ${x.role === 'admin' ? 'selected' : ''}>Admin (สลับได้ 2 โหมด)</option></select></td></tr>`).join('')}</tbody></table></div><div class="section-title admin-owner-head"><div><h3>กำหนดผู้ดูแลวัสดุหลัก</h3><p class="muted small">เปลี่ยนแล้วมีผลกับตัวกรองตรวจวันศุกร์ทันที</p></div><div class="search-box">${icon('search')}<input id="adminMaterialSearch" placeholder="ค้นหารหัส ชื่อ หรือผู้ดูแล"></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>รหัส</th><th>ชื่อวัสดุ</th><th>ขั้นต่ำ</th><th>ผู้ดูแล</th><th>จัดการ</th></tr></thead><tbody id="adminMaterialBody"></tbody></table></div>`;
  const drawMaterials = () => {
    const q = $('#adminMaterialSearch').value.toLowerCase();
    const arr = (m || []).filter(x => !q || `${x.code} ${x.name} ${x.responsible_email}`.toLowerCase().includes(q));
    $('#adminMaterialBody').innerHTML = arr.map(x => `<tr><td>${esc(x.code)}</td><td><strong>${esc(x.name)}</strong><div class="muted tiny">ชื่อบนสติ๊กเกอร์: ${esc(x.label_name || x.name)}</div></td><td>${qty(x.min_qty)} ${esc(x.unit)}</td><td><select data-owner-code="${esc(x.code)}">${ownerOptions(s, x.responsible_email || '')}</select></td><td><button class="mini" data-edit-material="${esc(x.code)}">แก้ไข</button></td></tr>`).join('');
    bindAdminOwnerEvents();
  };
  $('#adminMaterialSearch').addEventListener('input', drawMaterials);
  $$('[data-role-email]').forEach(sel => sel.addEventListener('change', async () => {
    const {error} = await sb.from('staff_directory').update({role:sel.value}).eq('email', sel.dataset.roleEmail);
    if (error) return toast(errMsg(error), true);
    toast('บันทึกสิทธิ์แล้ว');
    if (sel.dataset.roleEmail === profile.email) { await loadProfile(); actingMode = profile.role === 'admin' ? actingMode : 'staff'; updateRoleUI(); }
  }));
  drawMaterials();
}

function bindAdminOwnerEvents() {
  $$('[data-owner-code]').forEach(sel => sel.addEventListener('change', async () => {
    const {error} = await sb.from('materials').update({responsible_email: sel.value || null}).eq('code', sel.dataset.ownerCode);
    if (error) return toast(errMsg(error), true);
    stockCache = []; scanLotsCache=[]; scanLotsLoadedAt=0;
    materialsCache = [];
    const row = (window._adminMaterials || []).find(x => x.code === sel.dataset.ownerCode);
    if (row) row.responsible_email = sel.value || null;
    toast('เปลี่ยนผู้ดูแลแล้ว มีผลกับตรวจวันศุกร์ทันที');
  }));
}

function openMaterialEditor(code) {
  const x = (window._adminMaterials || []).find(m => m.code === code);
  const staff = window._adminStaff || [];
  if (!x) return;
  openModal(`<h3>${esc(x.code)} · ${esc(x.name)}</h3><form id="matForm" class="form-grid"><label>ชื่อบนสติ๊กเกอร์<input id="matLabel" maxlength="80" value="${esc(x.label_name || x.name)}"></label><label>จำนวนขั้นต่ำ<input id="matMin" type="number" min="0" step="0.01" value="${Number(x.min_qty || 0)}"></label><label>ผู้รับผิดชอบ<select id="matOwner">${ownerOptions(staff, x.responsible_email || '')}</select></label><button class="primary" type="submit">บันทึก</button></form>`);
  $('#matForm').addEventListener('submit', async e => {
    e.preventDefault();
    const {error} = await sb.from('materials').update({
      label_name:$('#matLabel').value.trim(),
      min_qty:Number($('#matMin').value),
      responsible_email:$('#matOwner').value || null
    }).eq('code', code);
    if (error) return toast(errMsg(error), true);
    closeModal();
    stockCache = []; scanLotsCache=[]; scanLotsLoadedAt=0;
    materialsCache = [];
    toast('บันทึกวัสดุแล้ว');
    renderAdmin();
  });
}

function renderHelp() {
  page.innerHTML = `<div class="page-head"><div><h2>คู่มือย่อ</h2><p class="muted small">CNMI Inventory v${APP_VERSION}</p></div></div><section class="card help-install-card"><div class="help-install-copy"><span class="install-panel-icon">${icon('smartphone')}</span><div><h3>ติดตั้ง CNMI Inventory บนโทรศัพท์</h3><p data-install-status>เลือก Android หรือ iPhone/iPad</p></div></div><div class="install-actions help-install-actions"><button class="install-platform-btn android" type="button" data-install-platform="android">${icon('download')}<span><b>ติดตั้ง Android</b><small data-install-label>ผ่าน Chrome</small></span></button><button class="install-platform-btn ios" type="button" data-install-platform="ios">${icon('share')}<span><b>ติดตั้ง iOS</b><small data-install-label>เปิดคู่มือ Safari</small></span></button></div></section><div class="grid help-grid"><div class="card help-card"><h3>สร้างบัญชีครั้งแรก</h3><ol class="help-steps"><li>ใช้เฉพาะอีเมลมหิดล @mahidol.ac.th ที่ Admin อนุญาตไว้</li><li>ตั้งรหัสผ่านสำหรับแอปอย่างน้อย 6 ตัว</li><li>กด “สร้างบัญชีครั้งแรก” แล้วกด “เข้าสู่ระบบ” ด้วยข้อมูลเดิม</li></ol></div><div class="card help-card"><h3>รับเข้าและพิมพ์ QR</h3><ol class="help-steps"><li>เปิดเมนู นำเข้า</li><li>กรองผู้ดูแลหรือพิมพ์ชื่อวัสดุบางส่วนแล้วเลือก</li><li>ใส่ Lot วันหมดอายุ และจำนวน แล้วบันทึก</li></ol></div><div class="card help-card"><h3>นำออก</h3><ol class="help-steps"><li>สแกน QR Sticker หรือพิมพ์รหัส Lot</li><li>ตรวจชื่อสินค้าและวิธีนำออก แล้วกด “ยืนยันนำออก 1 หน่วย”</li><li>ระบบบันทึกแยกเป็น “สแกน QR” หรือ “พิมพ์รหัสเอง” ในประวัติและรายงาน</li></ol></div><div class="card help-card"><h3>สต๊อกที่ฉันดูแล</h3><p>มี 3 เมนูย่อย: ภาพรวม, ต้องเบิก และตั้งค่าการเตือน เลือกเตือนตามจำนวนขั้นต่ำ เตือนรอบเบิกรายเดือน หรือไม่แจ้งเตือนได้ การเตือนรายเดือนจะเริ่มตรวจรอบตั้งแต่เดือนถัดไปหลังบันทึก</p></div><div class="card help-card"><h3>ตรวจวันศุกร์</h3><p>กรอกจำนวนที่นับได้จริง หากไม่ตรงกับระบบ ให้เลือกเหตุผล ระบบจะปรับยอดและเก็บชื่อผู้ตรวจไว้ในประวัติ</p></div><div class="card help-card"><h3>สแกนตรวจ Lot</h3><p>เปิดกล้องหรือพิมพ์รหัส QR เพื่อดูยอด Lot ยอดรวม ผู้ดูแล ขั้นต่ำ และยืนยันตรวจหรือปรับยอดได้ทันที</p></div><div class="card help-card"><h3>สถานะผู้ตรวจ</h3><p>เปิดเมนู “สถานะผู้ตรวจ” แล้วกำหนดช่วงวันที่ เพื่อดูว่าแต่ละวันศุกร์ใครตรวจครบหรือยังไม่ครบ</p></div><div class="card help-card"><h3>สติ๊กเกอร์เดิม</h3><p>สติ๊กเกอร์รหัสเดิมยังสแกนได้ ไม่ต้องเปลี่ยนใหม่ทั้งหมด</p></div><div class="card help-card"><h3>ของหมดอายุ</h3><p>ระบบไม่ตัดยอดเอง เปิดตรวจวันศุกร์และกด “ยืนยันนำออก” หลังตรวจว่าเอาออกจากพื้นที่จริงแล้ว จากนั้น Lot จะถูกปิดและไม่แสดงในสัปดาห์ถัดไป</p></div><div class="card help-card"><h3>ข้อมูลเดิม In / Out</h3><p>ประวัติจาก Excel เดิมดูได้ในหน้าประวัติและรายงาน</p></div><div class="card help-card"><h3>เครื่องพิมพ์สติ๊กเกอร์</h3><p>ฉลากกว้าง 25 mm สูง 20 mm ชื่อวัสดุจะย่อฟอนต์อัตโนมัติโดยไม่ตัด Lot/EXP ตั้ง Scale 100%, Margin None และปิด Header/Footer หากต้องการหลายดวงให้ใส่จำนวนในช่อง “จำนวนชุด” ของหน้าพิมพ์</p></div></div>`;
  refreshInstallUI();
}

init();
})();
