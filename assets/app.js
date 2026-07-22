(() => {
'use strict';

const APP_VERSION = '1.4.29';
const EXPIRY_REVIEW_START = '2026-07-01';
const DEFAULT_EXPIRY_ALERT_MONTHS = 1;
const MAX_EXPIRY_ALERT_MONTHS = 8;
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
let weeklyAdminActingForEmail = '';
let scannerStream = null;
let scannerTimer = null;
let authLogoutTimer = null;
let enteringApp = false;
let pendingIssueCode = new URLSearchParams(location.search).get('issue') || new URLSearchParams(location.search).get('lot');
let deferredInstallPrompt = null;
const MOVE_HISTORY_PAGE_SIZE = 7;
const REPORT_PAGE_SIZE = 10;
const LABEL_QUEUE_PAGE_SIZE = 10;
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

function useMobileMaterialPicker() {
  const narrow = window.matchMedia?.('(max-width: 700px)').matches;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  return Boolean(narrow || (coarse && window.innerWidth <= 900));
}

function materialComboboxMarkup({id, label = 'สินค้า', placeholder = 'พิมพ์ชื่อสินค้าบางส่วน', materials = [], initialCode = '', hint = ''}) {
  const selected = materials.find(m => m.code === initialCode);
  return `<label class="material-combo-label">${esc(label)}<div class="material-combobox" id="${esc(id)}Combo"><div class="material-combo-input-wrap">${icon('search')}<input id="${esc(id)}Search" class="material-combo-search" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(selected?.name || '')}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${esc(id)}Results" aria-haspopup="dialog"><button type="button" class="material-combo-clear ${selected ? '' : 'hidden'}" id="${esc(id)}Clear" aria-label="ล้างสินค้าที่เลือก">×</button></div><input type="hidden" id="${esc(id)}" value="${esc(selected?.code || '')}"><div class="material-combo-results hidden" id="${esc(id)}Results" role="listbox"></div><div class="material-selected-card ${selected ? '' : 'hidden'}" id="${esc(id)}SelectedCard"></div></div>${hint ? `<small class="field-hint">${esc(hint)}</small>` : ''}</label>`;
}

function rankMaterials(materials, query = '', ownerEmail = '') {
  const q = normalizeMaterialSearch(query);
  return materials.map(m => ({
    ...m,
    _name:normalizeMaterialSearch(m.name),
    _label:normalizeMaterialSearch(m.label_name),
    _code:normalizeMaterialSearch(m.code),
    _unit:normalizeMaterialSearch(m.unit),
    _owner:normalizeMaterialSearch(m.responsible_name || m.responsible_email)
  })).filter(m => !ownerEmail || m.responsible_email === ownerEmail).map(m => {
    let score = q ? 99 : 0;
    if (!q) score = 0;
    else if (m._name.startsWith(q)) score = 0;
    else if (m._name.includes(q)) score = 1;
    else if (m._label.startsWith(q)) score = 2;
    else if (m._label.includes(q)) score = 3;
    else if (m._code.startsWith(q)) score = 4;
    else if (m._code.includes(q)) score = 5;
    else if (m._owner.includes(q)) score = 6;
    else if (m._unit.includes(q)) score = 7;
    return {m,score};
  }).filter(x => x.score < 99).sort((a,b) => a.score - b.score || String(a.m.name).localeCompare(String(b.m.name),'th'));
}

function mobileMaterialPicker({materials, selectedCode = '', ownerEmail = '', onChoose}) {
  openModal(`<section class="mobile-material-picker"><header class="mobile-material-picker-head"><div><p class="eyebrow">Material search</p><h3>เลือกวัสดุ</h3><p>พิมพ์ชื่อหรือรหัสอย่างน้อย 2 ตัวอักษร</p></div><button class="icon-button" id="materialPickerClose" type="button" aria-label="ปิด">×</button></header><div class="mobile-material-picker-search">${icon('search')}<input id="mobileMaterialSearch" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" spellcheck="false" placeholder="เช่น กระดาษ A4 หรือ BB020"></div><div class="mobile-material-picker-results" id="mobileMaterialResults"></div><footer class="mobile-material-picker-footer"><button class="secondary" type="button" id="mobileMaterialClear">ล้างรายการที่เลือก</button></footer></section>`);
  $('#modal').classList.add('material-picker-open');
  const search = $('#mobileMaterialSearch');
  const results = $('#mobileMaterialResults');
  const draw = () => {
    const q = normalizeMaterialSearch(search.value);
    if (q.length < 2) {
      results.innerHTML = `<div class="mobile-material-picker-empty">${icon('search')}<strong>เริ่มค้นหาได้เลย</strong><span>พิมพ์อย่างน้อย 2 ตัวอักษร เพื่อให้รายการสั้นและแตะเลือกง่าย</span></div>`;
      return;
    }
    const ranked = rankMaterials(materials, q, ownerEmail).slice(0, 80);
    results.innerHTML = ranked.length ? ranked.map(({m}) => `<button type="button" class="mobile-material-option ${m.code === selectedCode ? 'selected' : ''}" data-mobile-material="${esc(m.code)}"><span class="mobile-material-option-main"><strong>${esc(m.name)}</strong><small>${esc(m.code)}${m.unit ? ` · หน่วย ${esc(m.unit)}` : ''}</small></span><span class="mobile-material-option-owner">${esc(m.responsible_name || 'ยังไม่กำหนดผู้ดูแล')}</span></button>`).join('') : `<div class="mobile-material-picker-empty">${icon('search')}<strong>ไม่พบวัสดุ</strong><span>ลองใช้ชื่อสั้นลง รหัส BB หรือคำอื่น</span></div>`;
  };
  search.addEventListener('input', draw);
  results.addEventListener('click', e => {
    const option = e.target.closest('[data-mobile-material]');
    if (!option) return;
    const item = materials.find(m => m.code === option.dataset.mobileMaterial) || null;
    closeModal();
    onChoose(item?.code || '', item);
  });
  $('#materialPickerClose').addEventListener('click', closeModal);
  $('#mobileMaterialClear').addEventListener('click', () => {
    closeModal();
    onChoose('', null);
  });
  requestAnimationFrame(() => {
    search.focus({preventScroll:true});
    draw();
  });
}

function setupMaterialCombobox(id, materials, {onChange = null, maxResults = 12, ownerSelectId = ''} = {}) {
  const input = $(`#${id}Search`);
  const hidden = $(`#${id}`);
  const results = $(`#${id}Results`);
  const clearBtn = $(`#${id}Clear`);
  const selectedCard = $(`#${id}SelectedCard`);
  const ownerFilter = ownerSelectId ? $(`#${ownerSelectId}`) : null;
  if (!input || !hidden || !results || !clearBtn) return {clear(){}, select(){}};
  let activeIndex = -1;
  const close = () => { results.classList.add('hidden'); input.setAttribute('aria-expanded','false'); activeIndex = -1; };
  const renderSelected = item => {
    if (!selectedCard) return;
    selectedCard.classList.toggle('hidden', !item);
    selectedCard.innerHTML = item ? `<span class="material-selected-icon">${icon('check')}</span><span><strong>${esc(item.name)}</strong><small>${esc(item.code)}${item.unit ? ` · หน่วย ${esc(item.unit)}` : ''}${item.responsible_name ? ` · ผู้ดูแล ${esc(item.responsible_name)}` : ''}</small></span>` : '';
  };
  const setActive = index => {
    const options = [...results.querySelectorAll('[data-material-option]')];
    if (!options.length) return;
    activeIndex = Math.max(0, Math.min(index, options.length - 1));
    options.forEach((btn,i) => btn.classList.toggle('active', i === activeIndex));
    options[activeIndex]?.scrollIntoView({block:'nearest'});
  };
  const choose = (code, trigger = true) => {
    const item = materials.find(m => m.code === code) || null;
    hidden.value = item?.code || '';
    input.value = item?.name || '';
    clearBtn.classList.toggle('hidden', !item);
    input.setCustomValidity('');
    renderSelected(item);
    close();
    input.blur();
    if (trigger && onChange) onChange(hidden.value, item);
  };
  const openMobile = () => mobileMaterialPicker({
    materials,
    selectedCode:hidden.value,
    ownerEmail:ownerFilter?.value || '',
    onChoose:(code,item) => choose(code, true)
  });
  const render = () => {
    if (useMobileMaterialPicker()) return;
    const q = normalizeMaterialSearch(input.value);
    const owner = ownerFilter?.value || '';
    hidden.value = '';
    clearBtn.classList.toggle('hidden', !input.value);
    let ranked = rankMaterials(materials, q, owner);
    if (!q && !owner) {
      results.innerHTML = '<div class="material-combo-empty">พิมพ์ชื่อบางส่วน หรือเลือกผู้ดูแลก่อน</div>';
      results.classList.remove('hidden');
      input.setAttribute('aria-expanded','true');
      activeIndex = -1;
      return;
    }
    const shown = ranked.slice(0,maxResults);
    results.innerHTML = shown.map(({m}) => `<button type="button" data-material-option="${esc(m.code)}" role="option"><span>${esc(m.name)}</span><small>${esc(m.responsible_name || 'ยังไม่กำหนดผู้ดูแล')}${m.unit ? ` · ${esc(m.unit)}` : ''}</small></button>`).join('') + (ranked.length > maxResults ? `<div class="material-combo-more">พบอีก ${ranked.length-maxResults} รายการ พิมพ์เพิ่มเพื่อกรองให้แคบลง</div>` : '') || '<div class="material-combo-empty">ไม่พบสินค้า ลองพิมพ์คำอื่นหรือเปลี่ยนผู้ดูแล</div>';
    results.classList.remove('hidden');
    input.setAttribute('aria-expanded','true');
    activeIndex = -1;
  };
  input.addEventListener('pointerdown', e => {
    if (!useMobileMaterialPicker()) return;
    e.preventDefault();
    input.blur();
    openMobile();
  });
  input.addEventListener('focus', () => {
    if (useMobileMaterialPicker()) {
      input.blur();
      openMobile();
      return;
    }
    render();
  });
  input.addEventListener('input', () => {
    if (useMobileMaterialPicker()) return;
    input.setCustomValidity('');
    hidden.value = '';
    renderSelected(null);
    if (onChange) onChange('', null);
    render();
  });
  input.addEventListener('keydown', e => {
    if (useMobileMaterialPicker()) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMobile(); }
      return;
    }
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
  clearBtn.addEventListener('click', e => {
    e.preventDefault();
    hidden.value = '';
    input.value = '';
    clearBtn.classList.add('hidden');
    renderSelected(null);
    close();
    if (onChange) onChange('', null);
    if (useMobileMaterialPicker()) openMobile();
    else { input.focus(); render(); }
  });
  ownerFilter?.addEventListener('change', () => {
    const selected = materials.find(m => m.code === hidden.value);
    if (selected && ownerFilter.value && selected.responsible_email !== ownerFilter.value) {
      hidden.value=''; input.value=''; clearBtn.classList.add('hidden'); renderSelected(null);
      if (onChange) onChange('',null);
    }
    render();
  });
  renderSelected(materials.find(m => m.code === hidden.value) || null);
  return {
    clear(trigger = true) {
      hidden.value = '';
      input.value = '';
      clearBtn.classList.add('hidden');
      renderSelected(null);
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
      if (typeof window.jsQR === 'function') return resolve(true);
      existing.addEventListener('load', () => resolve(typeof window.jsQR === 'function'), {once:true});
      existing.addEventListener('error', () => resolve(false), {once:true});
      setTimeout(() => resolve(typeof window.jsQR === 'function'), 2500);
      return;
    }
    const script = document.createElement('script');
    script.src = 'third_party/jsQR-1.4.0.js?v=1.4.29';
    script.async = false;
    script.dataset.jsqrLoader = '1';
    script.onload = () => resolve(typeof window.jsQR === 'function');
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
    setTimeout(() => resolve(typeof window.jsQR === 'function'), 2500);
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
  $('#modal').classList.remove('material-picker-open','scanner-open');
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
  openModal(`<div class="mobile-menu-sheet"><div class="mobile-menu-head"><span class="owner-avatar">${esc((profile?.display_name || '?').trim().charAt(0))}</span><div><h3>เมนูทั้งหมด</h3><p>${esc(profile?.display_name || '')}</p></div></div><div class="mobile-menu-grid"><button type="button" data-route="stock">${icon('box')}<span><strong>ค้นหาสต๊อกทั้งหมด</strong><small>ค้นหาสินค้าและ Lot</small></span></button><button type="button" data-route="my-stock">${icon('user')}<span><strong>สต๊อกที่ฉันดูแล</strong><small>ดูของที่มี ต้องเบิก และตั้งค่าการเตือน</small></span></button><button type="button" data-route="usage">${icon('chart')}<span><strong>วิเคราะห์การใช้</strong><small>การใช้และแนวโน้มหมดอายุ</small></span></button><button type="button" data-route="labels">${icon('print')}<span><strong>พิมพ์สติ๊กเกอร์</strong><small>คิวรับเข้าจากโทรศัพท์ · TSC / Zebra</small></span></button><button type="button" data-route="weekly">${icon('check')}<span><strong>ตรวจวันศุกร์</strong><small>ตรวจนับและปรับยอดจริง</small></span></button><button type="button" data-route="scan-stock">${icon('camera')}<span><strong>สแกนตรวจ Lot</strong><small>ดูยอดคงเหลือและตรวจด้วยกล้อง</small></span></button><button type="button" data-route="weekly-status">${icon('user')}<span><strong>สถานะผู้ตรวจ</strong><small>ดูย้อนหลังตามช่วงวันที่</small></span></button><button type="button" data-route="activity">${icon('history')}<span><strong>ประวัติ</strong><small>รายการที่ทำในระบบ</small></span></button><button type="button" data-route="reports">${icon('download')}<span><strong>รายงานและส่งออก</strong><small>CSV และข้อมูลย้อนหลัง</small></span></button>${adminItem}<button type="button" data-route="help">${icon('help')}<span><strong>คู่มือใช้งาน</strong><small>ขั้นตอนทำงาน</small></span></button><button type="button" data-open-install>${icon('smartphone')}<span><strong>ติดตั้งแอป</strong><small>Android และ iPhone/iPad</small></span></button></div></div>`);
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

function dateOnlyIso(date) {
  const x = new Date(date);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addCalendarMonths(date, months) {
  const source = new Date(date);
  const day = source.getDate();
  const result = new Date(source);
  result.setDate(1);
  result.setMonth(result.getMonth() + Number(months || 0));
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  result.setHours(0, 0, 0, 0);
  return result;
}

function expiryAlertMonths(x) {
  return Number(x?.expiry_alert_months) === 8 ? 8 : DEFAULT_EXPIRY_ALERT_MONTHS;
}

function expiryAlertLabel(x) {
  return `${expiryAlertMonths(x)} เดือน`;
}

function isNearExpiryDate(value, months = DEFAULT_EXPIRY_ALERT_MONTHS) {
  if (!value) return false;
  const expiry = new Date(`${value}T00:00:00`);
  if (Number.isNaN(expiry.getTime())) return false;
  const today = todayStart();
  return expiry >= today && expiry <= addCalendarMonths(today, months);
}

function isNearExpiryItem(x) {
  if (!x || isExpired(x)) return false;
  const months = expiryAlertMonths(x);
  if (x.expiry_date) return isNearExpiryDate(x.expiry_date, months);
  const days = Number(x.days_to_expiry);
  return Number.isFinite(days) && days >= 0 && days <= months * 31;
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
  ensureQrDecoder().catch(() => false);
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
  sb.auth.onAuthStateChange((event, nextSession) => {
    if (authLogoutTimer) { clearTimeout(authLogoutTimer); authLogoutTimer = null; }
    if (nextSession) {
      session = nextSession;
      if (event === 'SIGNED_IN' && appView.classList.contains('hidden') && !enteringApp) enterApp();
      return;
    }
    // iPhone/PWA อาจส่ง session ว่างชั่วคราวตอนสลับแอปหรือรีเฟรช token
    // รอและตรวจซ้ำก่อนพากลับหน้า login เพื่อไม่ให้หลุดจากระบบโดยไม่จำเป็น
    authLogoutTimer = setTimeout(async () => {
      try {
        const {data: latest} = await sb.auth.getSession();
        if (latest?.session) { session = latest.session; return; }
      } catch (_) {}
      session = null;
      showLogin();
    }, event === 'SIGNED_OUT' ? 250 : 2500);
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
  if (enteringApp) return;
  enteringApp = true;
  try {
    const {data, error} = await sb.auth.getSession();
    if (error) throw error;
    session = data.session;
    if (!session) return showLogin();
    await loadProfile();
    actingMode = isAdminAccount() ? (localStorage.getItem(`cnmi-inventory-mode:${profile.email}`) || 'staff') : 'staff';
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    updateRoleUI();
    const hashRoute = location.hash.replace(/^#/, '');
    const allowed = ['home','stock','my-stock','usage','urgent','move','labels','weekly','scan-stock','weekly-status','activity','reports','help','admin'];
    const initialRoute = allowed.includes(hashRoute) ? hashRoute : 'home';
    await navigate(initialRoute);
    if (pendingIssueCode) setTimeout(openPendingIssue, 250);
  } catch (e) {
    const message = errMsg(e);
    toast(message, true);
    // ห้าม signOut เมื่อเป็นปัญหาเครือข่าย/โหลดข้อมูลชั่วคราว เพราะทำให้ผู้ใช้หลุดจากระบบ
    if (/ยังไม่ได้รับสิทธิ์|inactive|JWT|refresh token|session/i.test(message)) {
      try { await sb.auth.signOut(); } catch (_) {}
      showLogin();
    }
  } finally {
    enteringApp = false;
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
  const quickPrint = e.target.closest('[data-quick-print]');
  if (quickPrint) {
    e.preventDefault();
    const lotId = quickPrint.dataset.quickPrint;
    const input = document.querySelector(`[data-label-copies="${CSS.escape(lotId)}"]`);
    const copies = normalizedLabelCopies(input?.value || 1);
    launchLabelPrint(lotId, copies);
    return;
  }
  const p = e.target.closest('[data-print]');
  if (p) {
    e.preventDefault();
    printLabel(p.dataset.print, Number(p.dataset.printCopies || 1));
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
    exportReport(exp.dataset.exportReport).catch(e => toast(errMsg(e), true));
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
    else if (r === 'labels') await renderLabels();
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
  if (isNearExpiryItem(x)) return `<span class="badge warn">ใกล้หมดอายุ ≤ ${expiryAlertLabel(x)}</span>`;
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
  if (String(a.action || '').startsWith('WEEKLY_DELEGATION')) {
    if (detail.to_name) detailParts.push(`ผู้รับ: ${detail.to_name}`);
    if (detail.item_count !== undefined) detailParts.push(`${qty(detail.item_count)} Lot`);
    if (detail.reason) detailParts.push(detail.reason);
  }
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
    sb.from('v_lot_balances').select('lot_id,expiry_date,days_to_expiry,expiry_alert_months').eq('active', true).eq('is_expired', false).gt('balance', 0).not('expiry_date', 'is', null).gte('expiry_date', dateOnlyIso(todayStart())).lte('expiry_date', dateOnlyIso(addCalendarMonths(todayStart(), MAX_EXPIRY_ALERT_MONTHS)))
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
  const nearExpiryCount = (nearRes.data || []).filter(isNearExpiryItem).length;
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
      <button class="card kpi kpi-button" data-route="stock" data-stock-filter="expiry"><div class="kpi-top"><span class="kpi-icon warn">${icon('calendar')}</span><small>ใกล้หมดอายุ (ตามเกณฑ์สินค้า)</small></div><strong>${nearExpiryCount}</strong><small>Lot</small></button>
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
  return `<div class="card lot-card ${isExpired(l) ? 'expired-card' : ''}"><div class="lot-main"><div class="lot-code">${icon('qr')} ${esc(lotKey(l))}</div><div class="lot-title">${esc(l.material_name)}</div><div class="lot-meta">Lot ${esc(l.lot_no)} · EXP ${d(l.expiry_date)}</div><div class="lot-meta">ผู้ดูแลหลัก: ${esc(l.responsible_name || '-')} · ผู้ช่วย: ${esc(l.assistant_responsible_name || '-')}</div>${aliases.length ? `<div class="legacy-note">สติ๊กเกอร์รหัสเดิมยังใช้ได้: ${aliases.map(esc).join(', ')}</div>` : ''}<div style="margin-top:8px">${statusBadge(l)}</div><div class="actions">${!isExpired(l) ? `<button class="mini" data-print="${esc(l.lot_id)}">${icon('print')} พิมพ์ QR</button>${Number(l.balance) > 0 ? `<button class="mini ghost" data-issue-lot="${esc(l.lot_id)}">${icon('minus')} นำออก</button>` : ''}` : `<button class="mini danger" data-route="weekly">${icon('check')} ยืนยันนำออกในตรวจวันศุกร์</button>`}</div></div><div class="qty-wrap"><div class="qty">${qty(l.balance)}</div><div class="muted small">${esc(l.unit)}</div></div></div>`;
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
      nearest_expiry:null, expired_pending_lots:0, expired_pending_balance:0, alert_mode:l.alert_mode || 'MINIMUM', reorder_day:l.reorder_day || 1, expiry_alert_months:expiryAlertMonths(l), needs_reorder:false, lots:[]
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
      alert_mode:g.alert_mode || 'MINIMUM', reorder_day:Number(g.reorder_day || 1), expiry_alert_months:expiryAlertMonths(g), needs_reorder:Boolean(g.needs_reorder),
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
  if (isNearExpiryDate(g.nearest_expiry, expiryAlertMonths(g))) return {key:'expiry',label:`ใกล้หมดอายุ ≤ ${expiryAlertLabel(g)}`,badge:'warn'};
  return {key:'positive',label:'คงเหลือปกติ',badge:'ok'};
}

function materialStockCard(g) {
  const st = materialGroupStatus(g);
  const nearExpiry = isNearExpiryDate(g.nearest_expiry, expiryAlertMonths(g));
  const expiryBadge = nearExpiry && st.key !== 'expiry' ? `<em class="badge warn">ใกล้หมดอายุ ≤ ${expiryAlertLabel(g)}</em>` : '';
  const ratio = g.min_qty > 0 ? Math.max(0, Math.min(100, g.total_balance / g.min_qty * 100)) : (g.total_balance > 0 ? 100 : 0);
  const ownerKey = g.responsible_email || 'unassigned';
  return `<article class="material-stock-card status-${st.key}">
    <div class="material-stock-main">
      <div class="material-ident"><button class="material-title-link" type="button" data-material-detail="${esc(g.material_code)}">${esc(g.material_name)}</button><button class="owner-inline-link" type="button" data-owner-detail="${esc(ownerKey)}">${icon('user')} ${esc(g.responsible_name || 'ยังไม่กำหนด')}</button></div>
      <div class="material-balance"><span>คงเหลือรวม</span><div><strong>${qty(g.total_balance)}</strong><small>${esc(g.unit)}</small></div><div class="level-track" title="เทียบกับขั้นต่ำ ${qty(g.min_qty)}"><i style="width:${ratio}%"></i></div><small>ขั้นต่ำ ${qty(g.min_qty)} ${esc(g.unit)}</small></div>
      <div class="material-facts"><div><span>Lot ที่ใช้งาน</span><strong>${g.active_lots}</strong></div><div><span>หมดอายุใกล้สุด</span><strong>${g.nearest_expiry ? d(g.nearest_expiry) : '-'}</strong></div><div><span>สถานะ</span><span class="material-status-badges"><em class="badge ${st.badge}">${st.label}</em>${expiryBadge}</span></div></div>
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
  const {data,error} = await sb.from('v_inventory_summary').select('*').or(`responsible_email.eq.${profile.email},assistant_responsible_email.eq.${profile.email}`).order('material_name');
  if (error) throw error;
  const groups = buildMaterialGroups(data || [], []);
  const reorder = groups.filter(g => g.needs_reorder);
  const monthly = groups.filter(g => g.alert_mode === 'MONTHLY').length;
  const tabBar = `<div class="my-stock-tabs"><button data-my-stock-tab="overview" class="${myStockTab==='overview'?'active':''}">ภาพรวม</button><button data-my-stock-tab="reorder" class="${myStockTab==='reorder'?'active':''}">ต้องเบิก <span>${reorder.length}</span></button><button data-my-stock-tab="settings" class="${myStockTab==='settings'?'active':''}">ตั้งค่าการเตือน</button></div>`;
  const summary = `<div class="my-stock-kpis"><div><span>ดูแลทั้งหมด</span><strong>${groups.length}</strong><small>รายการ</small></div><div><span>ต้องเบิก</span><strong>${reorder.length}</strong><small>รายการ</small></div><div><span>เตือนรายเดือน</span><strong>${monthly}</strong><small>รายการ</small></div></div>`;
  const overviewCards = groups.map(g=>{const st=materialGroupStatus(g);return `<article class="my-stock-card"><div class="my-stock-title"><div><h3>${esc(g.material_name)}</h3><p>คงเหลือ ${qty(g.total_balance)} ${esc(g.unit)} · ${g.active_lots} Lot</p></div><em class="badge ${st.badge}">${st.label}</em></div><div class="my-stock-meta"><span>${g.alert_mode==='MONTHLY' ? `เตือนวันที่ ${g.reorder_day} ของเดือน` : g.alert_mode==='NONE' ? 'ไม่เปิดแจ้งเตือน' : `ขั้นต่ำ ${qty(g.min_qty)} ${esc(g.unit)}`}</span><span>เตือนใกล้หมดอายุล่วงหน้า ${expiryAlertLabel(g)}</span></div><div class="my-stock-actions"><button type="button" class="mini ghost" data-material-detail="${esc(g.material_code)}">ดู Lot</button><button type="button" class="mini" data-material-usage="${esc(g.material_code)}">${icon('chart')} วิเคราะห์</button></div></article>`;}).join('');
  const reorderCards = reorder.map(g=>{const st=materialGroupStatus(g);return `<article class="my-stock-card needs-reorder"><div class="my-stock-title"><div><h3>${esc(g.material_name)}</h3><p>คงเหลือ ${qty(g.total_balance)} ${esc(g.unit)}</p></div><em class="badge ${st.badge}">${st.label}</em></div><div class="my-stock-actions"><button type="button" class="primary" data-route="move" data-move-tab="receive">รับเข้า</button><button type="button" class="mini" data-material-usage="${esc(g.material_code)}">ดูการใช้</button></div></article>`;}).join('');
  const settingsCards = groups.map(g=>`<form class="my-stock-card my-stock-setting-card" data-my-settings-form data-material-code="${esc(g.material_code)}"><div class="my-stock-title"><div><h3>${esc(g.material_name)}</h3><p>คงเหลือ ${qty(g.total_balance)} ${esc(g.unit)}</p></div></div><div class="stock-setting-grid"><label>รูปแบบแจ้งเตือน<select name="alert_mode"><option value="MINIMUM" ${g.alert_mode==='MINIMUM'?'selected':''}>เตือนตามจำนวนขั้นต่ำ</option><option value="MONTHLY" ${g.alert_mode==='MONTHLY'?'selected':''}>เตือนรอบเบิกรายเดือน</option><option value="NONE" ${g.alert_mode==='NONE'?'selected':''}>ไม่แจ้งเตือน</option></select></label><label data-minimum-field>จำนวนขั้นต่ำ<input name="minimum" type="number" min="0" step="0.01" value="${Number(g.min_qty || 0)}" inputmode="decimal"></label><label data-reorder-field>วันที่เตือนของเดือน (1–28)<input name="reorder_day" type="number" min="1" max="28" step="1" value="${Number(g.reorder_day || 1)}" inputmode="numeric"></label><label>แจ้งใกล้หมดอายุล่วงหน้า<select name="expiry_alert_months"><option value="1" ${expiryAlertMonths(g)===1?'selected':''}>1 เดือน — รายการทั่วไป</option><option value="8" ${expiryAlertMonths(g)===8?'selected':''}>8 เดือน — ต้องเคลมหรือจัดการล่วงหน้า</option></select></label></div><p class="field-hint">เกณฑ์นี้ใช้เฉพาะการขึ้นสถานะ “ใกล้หมดอายุ” ของวัสดุรายการนี้</p><button class="primary" type="submit">บันทึกการตั้งค่า</button></form>`).join('');
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
      const expiryMonths=Number(fd.get('expiry_alert_months') || DEFAULT_EXPIRY_ALERT_MONTHS);
      const btn=e.submitter; btn.disabled=true;
      const {error}=await sb.rpc('fn_update_my_stock_settings_v2',{p_material_code:form.dataset.materialCode,p_min_qty:min,p_alert_mode:String(fd.get('alert_mode')),p_reorder_day:day,p_acting_mode:actingMode,p_expiry_alert_months:expiryMonths});
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
  const nearCount = groups.filter(g => isNearExpiryDate(g.nearest_expiry, expiryAlertMonths(g))).length;
  const outCount = groups.filter(g => materialGroupStatus(g).key === 'out').length;
  const selectedFilter = initialFilter && initialFilter !== 'select' ? initialFilter : '';
  page.innerHTML = `<div class="page-head stock-page-head"><div><h2>สต๊อกคงเหลือ</h2><p class="muted small">เลือกสถานะ หรือพิมพ์ชื่อสินค้าบางส่วน ระบบจึงจะแสดงรายการ</p></div><button class="mini" data-route="usage">${icon('chart')} วิเคราะห์การใช้</button></div><div class="stock-summary-strip"><div><span>สินค้า</span><strong>${groups.length}</strong><small>รายการ</small></div><div><span>Lot ใช้งาน</span><strong>${activeLots}</strong><small>Lot</small></div><div><span>ต้องเบิก</span><strong>${reorderCount}</strong><small>รายการ</small></div><div><span>สินค้าหมด</span><strong>${outCount}</strong><small>รายการ</small></div><div><span>ใกล้หมดอายุ</span><strong>${nearCount}</strong><small>ตามเกณฑ์ 1/8 เดือน</small></div></div><section class="card stock-choice-card three"><label>เลือกผู้ดูแล<select id="stockOwnerFilter">${stockOwnerOptions}</select></label><label>เลือกสถานะ<select id="stockStatusSelect"><option value="">กรุณาเลือกสถานะ</option><option value="all">ทั้งหมด</option><option value="positive">คงเหลือปกติ</option><option value="reorder">ถึงรอบเบิก</option><option value="low">ต่ำกว่าขั้นต่ำ</option><option value="out">สินค้าหมด</option><option value="current-use">ใช้ชุดปัจจุบันอยู่</option><option value="notrack">ไม่เปิดแจ้งเตือน</option><option value="expiry">ใกล้หมดอายุ (ตามเกณฑ์สินค้า)</option><option value="expired">หมดอายุรอนำออก</option><option value="negative">ยอดติดลบ</option></select></label>${materialComboboxMarkup({id:'stockMaterialCode',label:'หรือค้นหาสินค้า',placeholder:'พิมพ์ชื่อสินค้าบางส่วน',materials:materialOptions})}</section><div id="materialStockList" class="material-stock-list"></div>`;
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
    if (filter && filter!=='all') arr=arr.filter(g=>filter==='expiry' ? isNearExpiryDate(g.nearest_expiry, expiryAlertMonths(g)) : materialGroupStatus(g).key===filter);
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


function normalizedLabelCopies(value, fallback = 1) {
  const parsed = Math.round(Number(value));
  return Math.max(1, Math.min(100, Number.isFinite(parsed) ? parsed : fallback));
}

async function launchLabelPrint(lotId, copies = 1) {
  const copyCount = normalizedLabelCopies(copies);
  const popup = window.open('about:blank', 'cnmi_inventory_label', 'width=520,height=430');
  if (!popup) return toast('เบราว์เซอร์บล็อกหน้าพิมพ์ กรุณาอนุญาต Pop-up ของเว็บไซต์นี้', true);
  popup.document.write(`<!doctype html><meta charset="utf-8"><title>กำลังเปิดหน้าพิมพ์</title><body style="font-family:system-ui;padding:24px"><b>กำลังเตรียมสติ๊กเกอร์</b><br>จำนวน ${copyCount} ดวง…</body>`);
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
      copies:String(copyCount),
      auto:'1'
    });
    const labelUrl = new URL('label.html', location.href);
    labelUrl.search = params.toString();
    popup.location.replace(labelUrl.toString());
    (async () => {
      try {
        const result = await sb.rpc('fn_log_label_print_v2', {p_lot_id:lotId,p_printer_profile:'UNIVERSAL',p_copy_count:copyCount});
        if (result.error) throw result.error;
      } catch (_) {
        try { await sb.rpc('fn_log_label_print', {p_lot_id:lotId}); } catch (_) {}
      }
    })();
  } catch (e) {
    popup.close();
    toast(errMsg(e), true);
  }
}

async function printLabel(lotId, defaultCopies = 1) {
  launchLabelPrint(lotId, defaultCopies);
}

function printLogProfile(summary = {}) {
  const raw = String(summary?.printer_profile || '').toUpperCase();
  if (raw === 'UNIVERSAL') return {name:'สติ๊กเกอร์มาตรฐาน'};
  if (raw === 'ZEBRA_420T') return {name:'Zebra 420t'};
  if (raw === 'TSC_310') return {name:'TSC 310'};
  return null;
}

function labelQueueRows(receiveRows = [], printRows = []) {
  const lastPrint = new Map();
  const printCount = new Map();
  printRows.forEach(row => {
    const id = String(row.entity_id || '');
    printCount.set(id, (printCount.get(id) || 0) + 1);
    if (!lastPrint.has(id)) lastPrint.set(id, row);
  });
  const latestByLot = new Map();
  receiveRows.forEach(row => {
    if (row.lot_id && !latestByLot.has(row.lot_id)) latestByLot.set(row.lot_id, row);
  });
  return [...latestByLot.values()].map(row => ({...row,_lastPrint:lastPrint.get(String(row.lot_id)) || null,_printCount:printCount.get(String(row.lot_id)) || 0}));
}

function labelQueueCard(row) {
  const printed = Boolean(row._lastPrint);
  const profile = printLogProfile(row._lastPrint?.summary || {});
  const defaultCopies = normalizedLabelCopies(Math.abs(Number(row.quantity_delta || 1)));
  const search = normalizeMaterialSearch([row.material_name,row.label_name,row.lot_key,row.lot_no,row.canonical_code,row.created_by_name].join(' '));
  const status = printed
    ? `<span class="badge ok">พิมพ์แล้ว ${qty(row._printCount)} ครั้ง</span><small>ล่าสุด ${profile ? esc(profile.name) : 'ไม่ระบุเครื่อง'} · ${dt(row._lastPrint.created_at)}</small>`
    : `<span class="badge warn">ยังไม่พิมพ์</span><small>พร้อมพิมพ์จากเครื่องที่ต่อ Printer</small>`;
  return `<article class="label-queue-card" data-label-queue-card data-printed="${printed ? '1' : '0'}" data-search="${esc(search)}"><div class="label-queue-main"><div class="label-queue-title"><div><strong>${esc(row.material_name || row.label_name || row.canonical_code || '-')}</strong><p><span class="code-pill">${esc(row.lot_key || `${row.canonical_code}-${row.lot_no}`)}</span> · รับเข้า ${dt(row.created_at)}</p></div><div class="label-print-status">${status}</div></div><div class="label-queue-meta"><span>จำนวนรับเข้า <b>${qty(Math.abs(Number(row.quantity_delta || 0)))} ${esc(row.unit || '')}</b></span><span>ผู้บันทึก <b>${esc(row.created_by_name || row.created_by_email || '-')}</b></span></div></div><div class="label-queue-actions"><label>จำนวนดวง<input type="number" min="1" max="100" step="1" inputmode="numeric" value="${defaultCopies}" data-label-copies="${esc(row.lot_id)}"></label><div class="label-printer-actions"><button type="button" class="primary" data-quick-print="${esc(row.lot_id)}">${icon('print')}<span><strong>พิมพ์สติ๊กเกอร์</strong></span></button></div></div></article>`;
}

async function renderLabels() {
  page.innerHTML = `<div class="page-head label-page-head"><div><p class="eyebrow">Label printing</p><h2>พิมพ์สติ๊กเกอร์</h2><p class="muted small">เลือกรายการและจำนวนดวง แล้วกดพิมพ์สติ๊กเกอร์ จากนั้นเลือกเครื่องพิมพ์และปรับกระดาษในหน้าพิมพ์ของ Chrome</p></div><button class="mini ghost" type="button" id="refreshLabelQueue">${icon('refresh')} รีเฟรช</button></div><section class="card label-queue-filter"><div class="search-box">${icon('search')}<input id="labelQueueSearch" type="search" placeholder="ค้นหาชื่อวัสดุ รหัส หรือ Lot"></div><div class="label-filter-tabs"><button type="button" class="active" data-label-filter="unprinted">ยังไม่พิมพ์</button><button type="button" data-label-filter="all">ทั้งหมด</button></div></section><div id="labelQueueList"><div class="card usage-loading">กำลังโหลดรายการรับเข้าล่าสุด…</div></div>`;
  const [receiveRes, printRes] = await Promise.all([
    sb.from('v_transaction_history').select('*').eq('tx_type','RECEIVE').order('created_at',{ascending:false}).order('id',{ascending:false}).limit(150),
    sb.from('v_audit_activity').select('entity_id,created_at,summary,actor_name,actor_email').eq('action','LABEL_PRINT').order('created_at',{ascending:false}).limit(500)
  ]);
  if (receiveRes.error) throw receiveRes.error;
  if (printRes.error) throw printRes.error;
  const rows = labelQueueRows(receiveRes.data || [], printRes.data || []);
  const container = $('#labelQueueList');
  container.innerHTML = rows.length ? rows.map(labelQueueCard).join('') : '<div class="card empty">ยังไม่มีรายการรับเข้า</div>';
  let filter = 'unprinted';
  const apply = () => {
    const q = normalizeMaterialSearch($('#labelQueueSearch')?.value || '');
    let visible = 0;
    $$('[data-label-queue-card]', container).forEach(card => {
      const showFilter = filter === 'all' || card.dataset.printed !== '1';
      const showSearch = !q || String(card.dataset.search || '').includes(q);
      const show = showFilter && showSearch;
      card.classList.toggle('hidden', !show);
      if (show) visible += 1;
    });
    let empty = $('#labelQueueEmpty');
    if (!empty) { empty=document.createElement('div'); empty.id='labelQueueEmpty'; empty.className='card empty hidden'; empty.textContent='ไม่พบรายการตามตัวกรอง'; container.appendChild(empty); }
    empty.classList.toggle('hidden', visible > 0);
  };
  $('#labelQueueSearch')?.addEventListener('input', apply);
  $$('[data-label-filter]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.labelFilter;
    $$('[data-label-filter]').forEach(x => x.classList.toggle('active', x === button));
    apply();
  }));
  $('#refreshLabelQueue')?.addEventListener('click', () => navigate('labels'));
  apply();
}

async function loadMaterials() {
  if (materialsCache.length) return materialsCache;
  const {data, error} = await sb.from('materials').select('*').eq('is_main', true).eq('status', 'Active').order('code');
  if (error) throw error;
  materialsCache = data || [];
  return materialsCache;
}

function transactionRows(rows, {showIssueMethod = false} = {}) {
  return (rows || []).map(x => {
    const recorder = x.created_by_name || x.created_by_email || 'SYSTEM';
    return `<tr><td>${dt(x.created_at)}</td><td><strong>${esc(x.material_name)}</strong></td><td><span class="code-pill">${esc(x.lot_key)}</span></td><td class="quantity-cell">${x.tx_type === 'RECEIVE' ? '+' : ''}${qty(x.quantity_delta)} ${esc(x.unit)}</td><td class="balance-cell">${qty(x.quantity_after)}</td>${showIssueMethod ? `<td class="issue-method-cell">${issueMethodBadge(x.issue_method)}</td>` : ''}<td class="recorder-cell"><span class="recorder-name">${esc(recorder)}</span></td></tr>`;
  }).join('');
}

function operatorNickname(value) {
  const text = String(value || '').trim();
  const match = text.match(/[（(]\s*([^()（）]+?)\s*[)）]\s*$/);
  if (match?.[1]) return match[1].trim();
  if (text.includes('@')) return text.split('@')[0].trim() || 'ผู้ใช้';
  const first = text.split(/\s+/).filter(Boolean)[0];
  return first || 'ผู้ใช้';
}

function currentOperatorMarkup(title = 'ผู้บันทึกรายการ') {
  const name = profile?.display_name || profile?.email || 'ผู้ใช้งานปัจจุบัน';
  const nickname = operatorNickname(name);
  return `<div class="current-operator" title="${esc(name)}" aria-label="${esc(title)} ${esc(nickname)}"><small>${esc(title)}</small><strong class="operator-nickname">${esc(nickname)}</strong></div>`;
}

async function fetchTransactionPage(txType, pageNumber = 1, pageSize = MOVE_HISTORY_PAGE_SIZE) {
  const safePage = Math.max(1, Number(pageNumber) || 1);
  const from = (safePage - 1) * pageSize;
  const {data, error, count} = await sb.from('v_transaction_history')
    .select('*', {count:'exact'})
    .eq('tx_type', txType)
    .order('created_at', {ascending:false})
    .order('id', {ascending:false})
    .range(from, from + pageSize - 1);
  if (error) throw error;
  return {rows:data || [], count:Number(count || 0), page:safePage, pageSize};
}

function moveHistoryMarkup(txType, result) {
  const issue = txType === 'ISSUE';
  const title = issue ? 'ประวัตินำออกล่าสุด' : 'ประวัตินำเข้าล่าสุด';
  const reportTarget = issue ? 'issue' : 'receive';
  const totalPages = Math.max(1, Math.ceil(result.count / result.pageSize));
  const first = result.count ? ((result.page - 1) * result.pageSize) + 1 : 0;
  const last = Math.min(result.page * result.pageSize, result.count);
  return `<div class="section-title compact history-heading-v145"><div><h3>${title}</h3><p class="muted small">แสดง ${result.pageSize} รายการต่อหน้า${result.count ? ` · รายการที่ ${first}–${last} จาก ${result.count}` : ''}</p></div><button class="mini ghost" type="button" data-open-report="${reportTarget}">ดูรายงานทั้งหมด</button></div><div class="table-wrap history-table-wrap"><table class="data-table history-table-v145"><thead><tr><th>วันเวลา</th><th>สินค้า</th><th>Lot</th><th>จำนวน</th><th>ยอดหลังทำ</th>${issue ? '<th>วิธีนำออก</th>' : ''}<th>ผู้บันทึก</th></tr></thead><tbody>${transactionRows(result.rows, {showIssueMethod:issue}) || `<tr><td colspan="${issue ? 7 : 6}" class="empty">ยังไม่มีรายการ</td></tr>`}</tbody></table></div><div class="table-pagination ${totalPages <= 1 ? 'single' : ''}"><span>หน้า ${Math.min(result.page,totalPages)} จาก ${totalPages}</span><div><button class="mini ghost" type="button" data-move-history-page="${result.page - 1}" ${result.page <= 1 ? 'disabled' : ''}>ก่อนหน้า</button><button class="mini" type="button" data-move-history-page="${result.page + 1}" ${result.page >= totalPages ? 'disabled' : ''}>ถัดไป</button></div></div>`;
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
  openModal(`<div class="scanned-result-head"><div><span class="eyebrow">ผลการสแกน</span><h3>${esc(l.material_name)}</h3><p>รหัส ${esc(l.material_code)}</p></div><em class="badge ${st.badge}">${st.label}</em></div><div class="scanned-lot-code"><span>Lot</span><strong>${esc(l.lot_no)}</strong><small>EXP ${d(l.expiry_date)}</small></div><div class="scanned-kpis"><div><span>คงเหลือ Lot นี้</span><strong>${qty(l.balance)}</strong><small>${esc(l.unit)}</small></div><div><span>คงเหลือรวม</span><strong>${qty(summary?.total_balance ?? l.balance)}</strong><small>${esc(l.unit)}</small></div><div><span>จำนวนขั้นต่ำ</span><strong>${qty(summary?.min_qty ?? l.min_qty)}</strong><small>${esc(l.unit)}</small></div></div><div class="scanned-owner"><span>${icon('user')}</span><div><small>ผู้ดูแลหลัก / ผู้ช่วยดูแล</small><strong>${esc(l.responsible_name || 'ยังไม่กำหนด')} · ${esc(l.assistant_responsible_name || 'ยังไม่กำหนด')}</strong></div></div><div class="scanned-actions">${checkActions}<button class="mini ghost" type="button" data-material-detail="${esc(l.material_code)}">ดู Lot อื่นของวัสดุนี้</button><button class="mini ghost" type="button" data-scan-again>${icon('camera')} สแกน Lot ถัดไป</button></div>`);
}

async function confirmScannedCheck(itemId) {
  const x=(window._weeklyItems || []).find(i=>i.item_id===itemId);
  if(!x)return toast('ไม่พบรายการตรวจ กรุณาสแกนใหม่',true);
  if(!canHandleItem(x))return toast('รายการนี้เป็นความรับผิดชอบของ '+(x.responsible_name||x.responsible_email),true);
  const btn=$(`[data-scan-confirm-check]`);
  if(btn)btn.disabled=true;
  const {error}=await sb.rpc('fn_save_stock_check',{p_item_id:itemId,p_actual_qty:Number(x.current_balance),p_reason_code:null,p_reason_detail:null,p_acting_mode:actingMode,p_acting_for_email:weeklyActingForEmail(x)});
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
  page.innerHTML = `<div class="page-head move-page-head"><div><p class="eyebrow">Stock movement</p><h2>นำเข้า–นำออก</h2><p class="muted small">บันทึกรายการด้วยบัญชีปัจจุบัน และเปิดประวัติทีละหน้าเพื่อลดการโหลดข้อมูล</p></div></div><div class="tabs move-tabs premium-tabs"><button data-tab="receive">${icon('plus')} นำเข้า</button><button data-tab="issue">${icon('minus')} นำออก</button></div><div id="movePane"></div>`;

  const bindHistory = txType => {
    const container = $('#moveHistory');
    if (!container) return;
    container.querySelectorAll('[data-move-history-page]').forEach(button => button.addEventListener('click', async () => {
      const targetPage = Number(button.dataset.moveHistoryPage || 1);
      if (targetPage < 1) return;
      button.disabled = true;
      container.classList.add('loading-soft');
      try {
        const result = await fetchTransactionPage(txType, targetPage);
        container.innerHTML = moveHistoryMarkup(txType, result);
        queueResponsiveTables(container);
        bindHistory(txType);
        container.scrollIntoView({behavior:'smooth', block:'start'});
      } catch (e) {
        container.innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`;
      } finally {
        container.classList.remove('loading-soft');
      }
    }));
    container.querySelector('[data-open-report]')?.addEventListener('click', () => {
      reportTab = container.querySelector('[data-open-report]').dataset.openReport || '';
      navigate('reports');
    });
  };

  const loadHistory = async txType => {
    const container = $('#moveHistory');
    if (!container) return;
    container.innerHTML = '<div class="usage-loading">กำลังโหลด 7 รายการล่าสุด…</div>';
    const result = await fetchTransactionPage(txType, 1);
    container.innerHTML = moveHistoryMarkup(txType, result);
    queueResponsiveTables(container);
    bindHistory(txType);
  };

  const draw = async tab => {
    moveTab = tab;
    navActive();
    $$('[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
    $('#movePane').innerHTML='<div class="card usage-loading">กำลังเปิดเมนูที่เลือก…</div>';
    if (tab === 'receive') {
      const [rawMats, staffRes] = await Promise.all([
        loadMaterials(),
        sb.from('staff_directory').select('email,display_name').eq('active',true).order('display_name')
      ]);
      if(staffRes.error) throw staffRes.error;
      const staffMap=new Map((staffRes.data||[]).map(x=>[x.email,x.display_name]));
      const mats=rawMats.map(m=>({...m,responsible_name:staffMap.get(m.responsible_email)||m.responsible_email||'ยังไม่กำหนด'}));
      $('#movePane').innerHTML = `<div class="move-layout move-layout-v145"><form id="receiveForm" class="card form-card form-grid move-action-card"><div class="form-title"><span>${icon('plus')}</span><div><p class="eyebrow">Receive stock</p><h3>บันทึกนำเข้า</h3></div></div>${currentOperatorMarkup('ผู้นำเข้า')}${materialComboboxMarkup({id:'rMat',label:'วัสดุ',placeholder:'พิมพ์ชื่อวัสดุ เช่น Panel, Papain',materials:mats})}<div class="form-grid two"><label>Lot<input id="rLot" autocomplete="off" autocapitalize="characters" maxlength="60" inputmode="latin" pattern="[A-Za-z0-9]*" placeholder="เช่น 8A145 หรือเว้นว่างเพื่อใช้วันที่นำเข้า"><small id="lotRule" class="field-hint lot-rule">กรอกได้เฉพาะตัวเลข 0–9 และภาษาอังกฤษ A–Z · ถ้าว่าง ระบบจะใช้วันที่นำเข้า</small></label><label>วันหมดอายุ<input id="rExp" type="date"><small class="field-hint">ถ้าไม่มีวันหมดอายุ สามารถเว้นว่างได้</small></label></div><label>จำนวน<input id="rQty" type="number" min="0.01" step="0.01" required inputmode="decimal"></label><button class="primary large" type="submit">${icon('plus')} บันทึกนำเข้า</button></form><aside class="card move-side-card"><div class="move-side-icon">${icon('box')}</div><div><p class="eyebrow">ขั้นตอนสั้น ๆ</p><h3>รับเข้าให้ครบในครั้งเดียว</h3><p>เลือกวัสดุ กรอก Lot วันหมดอายุ และจำนวน จากนั้นระบบจะบันทึกชื่อผู้ใช้งานปัจจุบันให้อัตโนมัติ</p></div><div class="move-side-points"><span><b>1</b> เลือกวัสดุ</span><span><b>2</b> ตรวจ Lot และ EXP</span><span><b>3</b> บันทึกและพิมพ์ QR</span></div></aside><section id="moveHistory" class="card history-card move-history-wide"></section></div>`;
      setupMaterialCombobox('rMat',mats,{maxResults:20});
      const lotInput=$('#rLot');
      lotInput.addEventListener('input',()=>prepareLotInput(lotInput));
      lotInput.addEventListener('blur',()=>prepareLotInput(lotInput,{autoFillBlank:true,showFallbackHint:true}));
      $('#receiveForm').addEventListener('submit', receive);
      await loadHistory('RECEIVE');
    } else {
      $('#movePane').innerHTML = `<div class="move-layout move-layout-v145"><section class="card issue-scan-simple move-action-card"><div class="form-title"><span>${icon('qr')}</span><div><p class="eyebrow">Issue stock</p><h3>นำออกด้วย QR Sticker</h3></div></div>${currentOperatorMarkup('ผู้นำออก')}<button class="primary camera-primary large" type="button" data-camera-scan>${icon('camera')} เปิดกล้องสแกน</button><div class="issue-or"><span>หรือพิมพ์รหัสเอง</span></div><form id="manualIssueForm" class="form-grid"><label>รหัส QR / รหัสล็อต<div class="toolbar issue-code-row" style="margin:0"><input id="issueCode" autocomplete="off" placeholder="เช่น BB020-69020" required><button type="submit" class="secondary">ค้นหา</button></div></label></form></section><aside class="card move-side-card issue-method-guide"><div class="move-side-icon">${icon('history')}</div><div><p class="eyebrow">บันทึกวิธีอัตโนมัติ</p><h3>ระบบแยกสแกนกับพิมพ์เอง</h3><p>รายการใหม่จะแสดงวิธีนำออกชัดเจนในประวัติและรายงาน ส่วนข้อมูลเดิมจะแสดงว่าไม่ระบุ</p></div><div class="method-preview"><span class="badge ok">สแกน QR</span><span class="badge info">พิมพ์รหัสเอง</span><span class="badge">ไม่ระบุ — ข้อมูลเดิม</span></div></aside><section id="moveHistory" class="card history-card move-history-wide"></section></div>`;
      $('#manualIssueForm').addEventListener('submit',e=>{e.preventDefault();const code=$('#issueCode').value.trim();if(!code)return toast('กรุณาพิมพ์รหัส QR หรือรหัสล็อต',true);resolveIssueCode(code);});
      await loadHistory('ISSUE');
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
  openModal(`<h3>รับเข้าเรียบร้อย</h3><p class="muted">ยอดใหม่ ${qty(row?.quantity_after)}</p><div class="receive-print-later-note">${icon('print')}<span><strong>พิมพ์ตอนนี้หรือพิมพ์ภายหลังก็ได้</strong><small>รายการนี้อยู่ในเมนู “พิมพ์สติ๊กเกอร์” แล้ว สามารถเปิดจากคอมพิวเตอร์ที่ต่อเครื่องพิมพ์สติ๊กเกอร์</small></span></div><div class="actions receive-success-actions"><button class="primary" data-print="${esc(row?.lot_id || '')}" data-print-copies="${normalizedLabelCopies(Number($('#rQty')?.value || 1))}">${icon('print')} พิมพ์สติ๊กเกอร์</button><button class="secondary" data-route="labels">ไปคิวพิมพ์</button><button class="ghost modal-close">ปิด</button></div>`);
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

function enhanceQrImage(imageData, contrast = 1.45, targetMean = 128) {
  const out = {data:new Uint8ClampedArray(imageData.data),width:imageData.width,height:imageData.height};
  const data = out.data;
  let total = 0;
  const pixels = Math.max(1, data.length / 4);
  for (let i = 0; i < data.length; i += 4) total += data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
  const sourceMean = total / pixels;
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114;
    const value = Math.max(0, Math.min(255, Math.round((gray - sourceMean) * contrast + targetMean)));
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  return { ...out, sourceMean };
}


function normalizeScanRect(rect, maxW, maxH) {
  if (!rect) return null;
  const x = Math.max(0, Math.min(maxW - 1, Math.round(rect.x || 0)));
  const y = Math.max(0, Math.min(maxH - 1, Math.round(rect.y || 0)));
  const w = Math.max(1, Math.min(maxW - x, Math.round(rect.w || rect.width || 0)));
  const h = Math.max(1, Math.min(maxH - y, Math.round(rect.h || rect.height || 0)));
  if (w < 20 || h < 20) return null;
  return {x,y,w,h};
}

function getScanFrameRect(videoEl, frameEl, canvasW, canvasH) {
  if (!videoEl || !frameEl || !canvasW || !canvasH) return null;
  const videoRect = videoEl.getBoundingClientRect();
  const frameRect = frameEl.getBoundingClientRect();
  if (!videoRect.width || !videoRect.height) return null;
  const left = ((frameRect.left - videoRect.left) / videoRect.width) * canvasW;
  const top = ((frameRect.top - videoRect.top) / videoRect.height) * canvasH;
  const width = (frameRect.width / videoRect.width) * canvasW;
  const height = (frameRect.height / videoRect.height) * canvasH;
  return normalizeScanRect({x:left,y:top,w:width,h:height}, canvasW, canvasH);
}

function inflateScanRect(rect, factor, maxW, maxH) {
  const nextW = rect.w * factor;
  const nextH = rect.h * factor;
  return normalizeScanRect({
    x: rect.x - (nextW - rect.w) / 2,
    y: rect.y - (nextH - rect.h) / 2,
    w: nextW,
    h: nextH
  }, maxW, maxH);
}

function cropCanvasRegion(sourceCanvas, rect) {
  const normalized = normalizeScanRect(rect, sourceCanvas.width, sourceCanvas.height);
  if (!normalized) return null;
  const out = document.createElement('canvas');
  out.width = normalized.w;
  out.height = normalized.h;
  const outCtx = out.getContext('2d', {willReadFrequently:true});
  outCtx.drawImage(sourceCanvas, normalized.x, normalized.y, normalized.w, normalized.h, 0, 0, normalized.w, normalized.h);
  return out;
}

function decodeQrCanvas(canvas, ctx) {
  if (typeof window.jsQR !== 'function' || !canvas.width || !canvas.height) return null;
  /*
    อ่านภาพเต็มก่อน เพื่อให้สแกนได้ทั้งใกล้และไกล
    จากนั้นค่อยลองพื้นที่กึ่งกลางหลายขนาดเป็น fallback
  */
  const attempts = [
    [0,0,canvas.width,canvas.height],
    [Math.round(canvas.width*.05),Math.round(canvas.height*.05),Math.round(canvas.width*.90),Math.round(canvas.height*.90)],
    [Math.round(canvas.width*.14),Math.round(canvas.height*.12),Math.round(canvas.width*.72),Math.round(canvas.height*.76)],
    [Math.round(canvas.width*.22),Math.round(canvas.height*.18),Math.round(canvas.width*.56),Math.round(canvas.height*.64)]
  ];
  const seen = new Set();
  for (const [x,y,w,h] of attempts) {
    const rect = normalizeScanRect({x,y,w,h}, canvas.width, canvas.height);
    if (!rect || rect.w < 80 || rect.h < 80) continue;
    const key = `${rect.x}:${rect.y}:${rect.w}:${rect.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const image = ctx.getImageData(rect.x,rect.y,rect.w,rect.h);
    const normal = window.jsQR(image.data,image.width,image.height,{inversionAttempts:'attemptBoth'});
    if (normal?.data) return normal.data;
    for (const [contrast,targetMean] of [[1.2,126],[1.4,132],[1.65,142],[1.95,150]]) {
      const enhanced = enhanceQrImage(image,contrast,targetMean);
      const decoded = window.jsQR(enhanced.data,enhanced.width,enhanced.height,{inversionAttempts:'attemptBoth'});
      if (decoded?.data) return decoded.data;
    }
  }
  return null;
}

function barcodeCenterDistance(code, width, height) {
  const box = code?.boundingBox;
  let cx = width / 2, cy = height / 2;
  if (box && Number.isFinite(box.x) && Number.isFinite(box.y)) {
    cx = box.x + box.width / 2;
    cy = box.y + box.height / 2;
  } else if (Array.isArray(code?.cornerPoints) && code.cornerPoints.length) {
    cx = code.cornerPoints.reduce((sum,p)=>sum+Number(p.x||0),0) / code.cornerPoints.length;
    cy = code.cornerPoints.reduce((sum,p)=>sum+Number(p.y||0),0) / code.cornerPoints.length;
  }
  return Math.hypot(cx-width/2,cy-height/2);
}

function pickCenteredBarcode(codes, width, height) {
  return [...(codes || [])]
    .filter(code => code?.rawValue)
    .sort((a,b)=>barcodeCenterDistance(a,width,height)-barcodeCenterDistance(b,width,height))[0]?.rawValue || '';
}

function drawVideoFrame(video, canvas, ctx) {
  const sourceW = Number(video.videoWidth || 0);
  const sourceH = Number(video.videoHeight || 0);
  if (!sourceW || !sourceH) return false;
  const maxSide = 1920;
  const scale = Math.min(1, maxSide / Math.max(sourceW, sourceH));
  const targetW = Math.max(1, Math.round(sourceW * scale));
  const targetH = Math.max(1, Math.round(sourceH * scale));
  if (canvas.width !== targetW) canvas.width = targetW;
  if (canvas.height !== targetH) canvas.height = targetH;
  ctx.drawImage(video, 0, 0, targetW, targetH);
  return true;
}

async function bitmapFromFile(file) {
  if ('createImageBitmap' in window) return await createImageBitmap(file);
  return await new Promise((resolve,reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('เปิดรูปไม่สำเร็จ')); };
    image.src = url;
  });
}

async function decodeQrPhoto(file) {
  if (!file) return '';
  if (!(await ensureQrDecoder())) throw new Error('ตัวอ่าน QR ในแอปยังโหลดไม่สำเร็จ กรุณารีเฟรชหน้าแล้วลองใหม่');
  const bitmap = await bitmapFromFile(file);
  const sourceW = bitmap.width || bitmap.naturalWidth || 0;
  const sourceH = bitmap.height || bitmap.naturalHeight || 0;
  if (!sourceW || !sourceH) throw new Error('รูปไม่มีขนาดที่อ่านได้');
  const scale = Math.min(1, 2400 / Math.max(sourceW,sourceH));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1,Math.round(sourceW*scale));
  canvas.height = Math.max(1,Math.round(sourceH*scale));
  const ctx = canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  bitmap.close?.();
  return decodeQrCanvas(canvas,ctx) || '';
}

function scannerFallbackMarkup(inspectMode, message = '') {
  return `<div class="scanner-fallback"><h3>${message ? 'เปิดกล้องหรืออ่าน QR ไม่สำเร็จ' : 'สแกนจากรูปหรือพิมพ์รหัส'}</h3>${message ? `<p>${esc(message)}</p>` : ''}<label class="photo-scan-button secondary">${icon('camera')} ถ่ายรูป/เลือกรูป QR<input id="scanPhotoInput" type="file" accept="image/*" capture="environment" hidden></label><div id="photoScanStatus" class="field-hint"></div><form id="manualScanForm" class="form-grid"><label>พิมพ์รหัส QR<input id="manualScanCode" placeholder="เช่น BB319-09062026" autocomplete="off"></label><button class="primary" type="submit">${inspectMode?'ตรวจสอบ Lot':'ค้นหา Lot'}</button></form></div>`;
}

function bindScannerFallback({inspectMode, submitCode, closeOnSuccess = true}) {
  $('#manualScanForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const code = $('#manualScanCode')?.value || '';
    if (closeOnSuccess) closeModal();
    submitCode(code,'manual');
  });
  $('#scanPhotoInput')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const status = $('#photoScanStatus') || $('#scanStatus');
    if (status) status.textContent = 'กำลังอ่าน QR จากรูป…';
    try {
      const value = await decodeQrPhoto(file);
      if (!value) throw new Error('ยังไม่พบ QR ในรูป ลองถ่ายให้ QR ตรง ไม่เบลอ และมีแสงพอ');
      if (closeOnSuccess) closeModal();
      submitCode(value,'scan');
    } catch (err) {
      if (status) status.textContent = errMsg(err);
      toast(errMsg(err),true);
    } finally {
      e.target.value = '';
    }
  });
}

async function startCameraScanner(mode = 'issue') {
  const inspectMode = mode === 'inspect';
  const resolveCode = inspectMode ? resolveStockCheckCode : resolveIssueCode;
  const submitCode = (value, source = 'manual') => inspectMode ? resolveCode(value) : resolveCode(value, source);
  const title = inspectMode ? 'สแกนตรวจ Lot' : 'สแกน QR Sticker';
  const description = inspectMode ? 'หันกล้องไปที่ QR ระบบอ่านได้ทั้งใกล้และไกล โดยเลือกดวงที่อยู่กึ่งกลางเป็นหลัก' : 'หันกล้องไปที่ QR ระบบอ่านได้ทั้งใกล้และไกล โดยเลือกดวงที่อยู่กึ่งกลางเป็นหลัก';
  if (!navigator.mediaDevices?.getUserMedia) {
    openModal(scannerFallbackMarkup(inspectMode,'อุปกรณ์นี้ไม่รองรับการเปิดกล้องสดผ่านเว็บ ใช้การถ่ายรูป QR หรือพิมพ์รหัสแทนได้'));
    bindScannerFallback({inspectMode,submitCode});
    return;
  }

  openModal(`<div class="scanner-head"><div><h3>${title}</h3><p>${description}</p></div><button class="icon-button modal-close" type="button" aria-label="ปิด">×</button></div><div class="scanner-guide">วาง QR ที่ต้องการไว้ใกล้กึ่งกลางภาพ</div><div class="scan-video-wrap"><video id="scanVideo" autoplay playsinline muted></video><canvas id="scanCanvas" hidden></canvas><div id="scanStatus" class="scan-status">กำลังเปิดกล้อง…</div></div><div class="scanner-actions"><label class="photo-scan-button secondary">${icon('camera')} ถ่ายรูป/เลือกรูป QR<input id="scanPhotoInput" type="file" accept="image/*" capture="environment" hidden></label><button type="button" class="secondary hidden" id="scannerTorchBtn">เปิดไฟฉาย</button></div><div id="photoScanStatus" class="field-hint"></div><p class="muted small scanner-tip">รองรับ iPhone/iPad และ Android · สแกนได้ทั้งใกล้และไกล · หากมีหลายดวง ระบบเลือกดวงที่อยู่กึ่งกลางเป็นหลัก</p><form id="manualScanForm" class="scanner-manual form-grid"><label>หรือพิมพ์รหัส QR<input id="manualScanCode" placeholder="เช่น BB319-09062026" autocomplete="off"></label><button class="secondary" type="submit">${inspectMode?'ตรวจสอบ Lot':'ค้นหา Lot'}</button></form>`);
  $('#modal').classList.add('scanner-open');
  bindScannerFallback({inspectMode,submitCode});

  const status = $('#scanStatus');
  try {
    let stream;
    const preferred = {video:{facingMode:{ideal:'environment'},width:{ideal:1280,min:640},height:{ideal:720,min:480}},audio:false};
    try {
      stream = await navigator.mediaDevices.getUserMedia(preferred);
    } catch (_) {
      stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});
    }
    scannerStream = stream;
    const video = $('#scanVideo');
    const canvas = $('#scanCanvas');
    const ctx = canvas.getContext('2d',{willReadFrequently:true});
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline','');
    video.setAttribute('webkit-playsinline','');
    video.disablePictureInPicture = true;
    video.srcObject = scannerStream;
    if (!video.videoWidth) {
      await Promise.race([
        new Promise(resolve => video.addEventListener('loadedmetadata', resolve, {once:true})),
        new Promise(resolve => setTimeout(resolve, 700))
      ]);
    }
    await video.play();

    const track = scannerStream.getVideoTracks()[0];
    let torchSupported = false;
    let torchOn = false;
    let setTorch = async () => false;
    try {
      const caps = track.getCapabilities?.() || {};
      const advanced = {};
      if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) advanced.focusMode = 'continuous';
      if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) advanced.exposureMode = 'continuous';
      if (caps.exposureCompensation && Number.isFinite(caps.exposureCompensation.max)) {
        advanced.exposureCompensation = Math.min(caps.exposureCompensation.max, Math.max(caps.exposureCompensation.min || 0, .5));
      }
      if (Object.keys(advanced).length) await track.applyConstraints({advanced:[advanced]});
      if (caps.torch) {
        torchSupported = true;
        const torch = $('#scannerTorchBtn');
        torch.classList.remove('hidden');
        setTorch = async next => {
          try {
            await track.applyConstraints({advanced:[{torch:Boolean(next)}]});
            torchOn = Boolean(next);
            torch.textContent = torchOn ? 'ปิดไฟฉาย' : 'เปิดไฟฉาย';
            return true;
          } catch (_) {
            torchSupported = false;
            torchOn = false;
            torch.classList.add('hidden');
            return false;
          }
        };
        torch.addEventListener('click', async () => { await setTorch(!torchOn); });
      }
    } catch (_) {}

    let detector = null;
    if ('BarcodeDetector' in window) {
      try {
        const supported = await BarcodeDetector.getSupportedFormats?.();
        if (!supported || supported.includes('qr_code')) detector = new BarcodeDetector({formats:['qr_code']});
      } catch (_) {}
    }
    const decoderReady = detector ? true : await ensureQrDecoder();
    if (!detector && !decoderReady) throw new Error('ตัวอ่าน QR ภายในแอปโหลดไม่สำเร็จ กรุณารีเฟรชหน้าแล้วลองใหม่');
    status.textContent = 'พร้อมสแกน QR';

    let busy = false;
    let scans = 0;
    const finish = value => {
      if (!value) return false;
      stopScanner();
      closeModal();
      submitCode(value,'scan');
      return true;
    };
    const scan = async () => {
      if (!scannerStream || $('#modal').classList.contains('hidden')) return;
      if (!busy && video.readyState >= 2) {
        busy = true;
        try {
          let value = '';
          if (detector) {
            const codes = await detector.detect(video);
            value = pickCenteredBarcode(codes, Number(video.videoWidth||1), Number(video.videoHeight||1));
          }
          const frameReady = !value && drawVideoFrame(video,canvas,ctx);
          if (!value && typeof window.jsQR === 'function' && frameReady) {
            const image = ctx.getImageData(0,0,canvas.width,canvas.height);
            const fast = window.jsQR(image.data,image.width,image.height,{inversionAttempts:'dontInvert'});
            value = fast?.data || '';
            if (!value && scans % 8 === 0) value = decodeQrCanvas(canvas,ctx) || '';
          }
          if (finish(value)) return;
          scans += 1;
          if (scans === 18) status.textContent = 'วาง QR ที่ต้องการไว้ใกล้กึ่งกลางภาพ แล้วถือให้นิ่ง';
          if (scans === 24 && torchSupported && !torchOn) {
            if (await setTorch(true)) status.textContent = 'แสงค่อนข้างน้อย ระบบเปิดไฟฉายให้อัตโนมัติ';
          }
          if (scans === 36 && !torchOn) status.textContent = 'หากยังไม่อ่าน ลองขยับเข้าออกได้ทั้งใกล้และไกลจนภาพคม';
          if (scans === 75) status.textContent = 'ยังอ่านไม่ได้ ลองถ่ายรูป QR ด้านล่าง';
        } catch (_) {
        } finally {
          busy = false;
        }
      }
      scannerTimer = setTimeout(scan,55);
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
    $('#modalBody').innerHTML = scannerFallbackMarkup(inspectMode,message);
    bindScannerFallback({inspectMode,submitCode});
  }
}

function stopScanner() {
  if (scannerTimer) clearTimeout(scannerTimer);
  scannerTimer = null;
  if (scannerStream) scannerStream.getTracks().forEach(t => t.stop());
  scannerStream = null;
}

function weeklyOwnerEmail(x) {
  return String(x?.responsible_email || '').trim().toLowerCase();
}

function weeklyDelegatedEmail(x) {
  return String(x?.delegated_to_email || '').trim().toLowerCase();
}

function weeklyDelegationActive(x) {
  return ['ACCEPTED','ADMIN_ASSIGNED','COMPLETED'].includes(String(x?.delegation_status || '').toUpperCase());
}

function weeklyDelegationWaiting(x) {
  return String(x?.delegation_status || '').toUpperCase() === 'PENDING';
}

function canHandleItem(x) {
  const me = String(profile?.email || '').trim().toLowerCase();
  const owner = weeklyOwnerEmail(x);
  if (isAdminMode()) {
    if (route === 'weekly') {
      return Boolean(weeklyAdminActingForEmail) && owner === String(weeklyAdminActingForEmail).toLowerCase();
    }
    return true;
  }
  if (owner && owner === me) return true;
  const assistant = String(x?.assistant_responsible_email || '').trim().toLowerCase();
  if (assistant && assistant === me) return true;
  return ['ACCEPTED','ADMIN_ASSIGNED'].includes(String(x?.delegation_status || '').toUpperCase())
    && weeklyDelegatedEmail(x) === me;
}

function weeklyDelegationBadge(x) {
  const status = String(x?.delegation_status || '').toUpperCase();
  const ownerNick = operatorNickname(x?.responsible_name || x?.responsible_email || 'ผู้ดูแล');
  const targetNick = operatorNickname(x?.delegated_to_name || x?.delegated_to_email || 'ผู้ตรวจแทน');
  if (status === 'PENDING') return `<span class="badge warn">รอ ${esc(targetNick)} ยืนยัน</span>`;
  if (status === 'ACCEPTED') return `<span class="badge info">${esc(targetNick)} รับตรวจแทน ${esc(ownerNick)}</span>`;
  if (status === 'ADMIN_ASSIGNED') return `<span class="badge info">Admin มอบหมายให้ ${esc(targetNick)}</span>`;
  if (status === 'REJECTED') return `<span class="badge danger">${esc(targetNick)} ปฏิเสธแล้ว</span>`;
  if (status === 'CANCELLED') return `<span class="badge">ยกเลิกการมอบหมายแล้ว</span>`;
  if (status === 'COMPLETED' && weeklyDelegatedEmail(x) && weeklyDelegatedEmail(x) !== weeklyOwnerEmail(x)) return `<span class="badge ok">${esc(targetNick)} ตรวจแทนแล้ว</span>`;
  return '';
}

function weeklyItemCard(x) {
  const expired = requiresExpiryConfirmation(x) && x.checked_at == null;
  const resultText = x.result === 'MATCHED' ? 'ตรง' : x.result === 'ADJUSTED' ? 'ปรับแล้ว' : x.result === 'EXPIRED_REMOVED' ? 'นำหมดอายุออกแล้ว' : '';
  const resultClass = x.result === 'MATCHED' ? 'ok' : x.result === 'EXPIRED_REMOVED' ? 'danger' : 'warn';
  const me = String(profile?.email || '').toLowerCase();
  const owner = weeklyOwnerEmail(x);
  const delegatedToMe = weeklyDelegatedEmail(x) === me;
  const ownerNick = operatorNickname(x.responsible_name || x.responsible_email || 'ผู้ดูแล');
  const checkerNick = operatorNickname(x.checked_by_name || x.checked_by_email || '');
  const delegateBadge = weeklyDelegationBadge(x);
  let action = '';
  if (x.checked_at) action = `<span class="badge ${resultClass}">${resultText}</span>`;
  else if (weeklyDelegationWaiting(x)) {
    action = delegatedToMe
      ? `<span class="badge warn">รอคุณตอบรับด้านบน</span>`
      : `<span class="badge warn">รอ ${esc(operatorNickname(x.delegated_to_name || x.delegated_to_email))} ยืนยัน</span>`;
  } else if (!canHandleItem(x)) {
    if (isAdminMode() && !weeklyAdminActingForEmail) action = '<span class="badge">เลือกชื่อเจ้าหน้าที่ด้านบน</span>';
    else if (weeklyDelegationActive(x) && x.delegated_to_name) action = `<span class="badge">รอ ${esc(operatorNickname(x.delegated_to_name))} ตรวจแทน</span>`;
    else action = `<span class="badge">รอ ${esc(ownerNick)}</span>`;
  } else if (expired) action = `<button class="mini danger" data-expired-remove="${esc(x.item_id)}">ยืนยันนำออก</button>`;
  else action = `<button class="mini" data-check="${esc(x.item_id)}">ตรวจ</button>`;

  const delegationLine = delegateBadge ? `<div class="weekly-delegation-line">${delegateBadge}${x.delegation_reason ? `<small>${esc(x.delegation_reason)}</small>` : ''}</div>` : '';
  const checkerLine = x.checked_at
    ? `<div class="lot-meta">${owner && String(x.checked_by_email || '').toLowerCase() !== owner ? `${esc(checkerNick)} ตรวจแทน ${esc(ownerNick)}` : `ดำเนินการโดย ${esc(x.checked_by_name || x.checked_by_email)}`} · ${dt(x.checked_at)}</div>`
    : '';
  return `<div class="card check-card ${x.checked_at ? (x.result === 'ADJUSTED' ? 'mismatch' : x.result === 'EXPIRED_REMOVED' ? 'expired-done' : 'checked') : expired ? 'expired-card' : ''}"><div class="check-info"><div><strong>${esc(x.material_name)}</strong><div class="lot-meta">${esc(lotKey(x))} · ระบบ ${qty(x.current_balance)} ${esc(x.unit)} · EXP ${d(x.expiry_date)}</div><div class="lot-meta">ผู้ดูแล: ${esc(x.responsible_name || '-')}</div>${delegationLine}${expired ? '<div class="expired-callout">หมดอายุแล้ว: ไม่ต้องนับ ให้ตรวจว่านำออกจากพื้นที่จริงแล้ว</div>' : ''}${checkerLine}</div>${action}</div></div>`;
}

function groupWeeklyDelegations(items, predicate) {
  const groups = new Map();
  (items || []).filter(predicate).forEach(item => {
    const key = item.delegation_batch_id || `single-${item.item_id}`;
    if (!groups.has(key)) groups.set(key, {
      batchId:item.delegation_batch_id,
      items:[],
      fromName:item.delegated_by_name || item.responsible_name || item.delegated_by_email,
      toName:item.delegated_to_name || item.delegated_to_email,
      reason:item.delegation_reason || '-',
      status:item.delegation_status || ''
    });
    groups.get(key).items.push(item);
  });
  return [...groups.values()];
}

function weeklyDelegationPanels(items) {
  const me = String(profile?.email || '').toLowerCase();
  const incoming = groupWeeklyDelegations(items, x => !x.checked_at && weeklyDelegationWaiting(x) && weeklyDelegatedEmail(x) === me);
  const outgoing = groupWeeklyDelegations(items, x => !x.checked_at && ['PENDING','ACCEPTED','ADMIN_ASSIGNED'].includes(String(x.delegation_status || '').toUpperCase()) && (String(x.delegated_by_email || '').toLowerCase() === me || weeklyOwnerEmail(x) === me || isAdminMode()));
  const incomingHtml = incoming.length ? `<section class="card delegation-panel delegation-incoming"><div class="section-title compact"><div><p class="eyebrow">Delegation inbox</p><h3>คำขอตรวจแทน</h3></div><span class="badge warn">${incoming.length} คำขอ</span></div><div class="delegation-request-list">${incoming.map(g => `<article><div><strong>${esc(operatorNickname(g.fromName))} ฝากตรวจ ${g.items.length} Lot</strong><small>${esc(g.reason)}</small><span>${g.items.slice(0,3).map(x=>esc(x.material_name)).join(' · ')}${g.items.length>3?' …':''}</span></div><div class="delegation-request-actions"><button class="primary mini" data-delegation-response="accept" data-delegation-batch="${esc(g.batchId)}">รับงาน</button><button class="secondary mini" data-delegation-response="reject" data-delegation-batch="${esc(g.batchId)}">ปฏิเสธ</button></div></article>`).join('')}</div></section>` : '';
  const outgoingHtml = outgoing.length ? `<section class="card delegation-panel"><div class="section-title compact"><div><p class="eyebrow">Delegated work</p><h3>งานที่มอบหมายไว้</h3></div><span class="badge info">${outgoing.reduce((n,g)=>n+g.items.length,0)} Lot</span></div><div class="delegation-outgoing-list">${outgoing.map(g => `<article><div><strong>${esc(operatorNickname(g.toName))} · ${g.items.length} Lot</strong><small>${g.status === 'PENDING' ? 'รอยืนยัน' : g.status === 'ACCEPTED' ? 'รับงานแล้ว' : 'Admin มอบหมายแล้ว'} · ${esc(g.reason)}</small></div><button class="mini ghost" data-delegation-cancel="${esc(g.batchId)}">ยกเลิก</button></article>`).join('')}</div></section>` : '';
  return incomingHtml + outgoingHtml;
}

function openWeeklyDelegateModal(items, staff, check) {
  const adminMode = isAdminMode();
  const me = String(profile?.email || '').toLowerCase();
  const owners = [...new Map((items || []).filter(x=>!x.checked_at && x.responsible_email).map(x=>[x.responsible_email,x.responsible_name || x.responsible_email])).entries()].sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'th'));
  const defaultOwner = adminMode ? (weeklyAdminActingForEmail || owners[0]?.[0] || '') : profile.email;
  const activeDelegation = x => ['PENDING','ACCEPTED','ADMIN_ASSIGNED'].includes(String(x.delegation_status || '').toUpperCase());
  const eligibleForOwner = email => (items || []).filter(x => !x.checked_at && weeklyOwnerEmail(x) === String(email || '').toLowerCase() && !activeDelegation(x));
  const targetOptions = (staff || []).filter(s => s.email && (adminMode || String(s.email).toLowerCase() !== me)).map(s => `<option value="${esc(s.email)}">${esc(s.display_name)}</option>`).join('');
  if (!targetOptions) return toast('ไม่พบเจ้าหน้าที่สำหรับรับงานแทน', true);

  openModal(`<section class="weekly-delegate-modal"><div class="section-title"><div><p class="eyebrow">Weekly delegation</p><h3>${adminMode ? 'มอบหมายผู้ตรวจแทน' : 'ฝากเพื่อนตรวจแทน'}</h3><p class="muted small">รอบวันที่ ${d(check?.week_friday)}</p></div></div><form id="weeklyDelegateForm" class="form-grid">${adminMode ? `<label>เจ้าของงาน<select id="delegateOwner">${owners.map(([email,name])=>`<option value="${esc(email)}" ${email===defaultOwner?'selected':''}>${esc(name)}</option>`).join('')}</select></label>` : `<div class="delegate-owner-fixed"><small>เจ้าของงาน</small><strong>${esc(profile.display_name || profile.email)}</strong></div>`}<label>ผู้ตรวจแทน<select id="delegateTarget" required><option value="">เลือกผู้ตรวจแทน</option>${targetOptions}</select></label><fieldset class="delegate-scope"><legend>รายการที่ฝาก</legend><label><input type="radio" name="delegateScope" value="all" checked> ฝากทั้งหมดที่ยังไม่ตรวจ</label><label><input type="radio" name="delegateScope" value="selected"> เลือกเฉพาะบางรายการ</label></fieldset><div id="delegateItemList" class="delegate-item-list"></div><label>เหตุผล<select id="delegateReason" required><option value="">เลือกเหตุผล</option><option>ลาพักร้อน</option><option>ลาป่วย</option><option>ออกหน่วย</option><option>อบรม/ประชุม</option><option>ติดภารกิจ</option><option>อื่น ๆ</option></select></label><label>รายละเอียดเพิ่มเติม<textarea id="delegateDetail" rows="2" placeholder="ระบุเพิ่มเติมได้"></textarea></label><p class="notice">${adminMode ? 'Admin มอบหมายแล้วมีผลทันที ผู้รับไม่ต้องกดยืนยัน แต่ระบบยังบันทึกผู้ตรวจจริงแยกจากเจ้าของวัสดุ' : 'ผู้รับต้องกดรับงานก่อน จึงจะสามารถตรวจแทนได้'}</p><button class="primary" type="submit">${adminMode ? 'มอบหมายทันที' : 'ส่งคำขอฝากตรวจ'}</button></form></section>`);

  const ownerInput = $('#delegateOwner');
  const list = $('#delegateItemList');
  const drawItems = () => {
    const ownerEmail = adminMode ? ownerInput?.value : profile.email;
    const eligible = eligibleForOwner(ownerEmail);
    const selectedMode = document.querySelector('input[name="delegateScope"]:checked')?.value === 'selected';
    list.innerHTML = eligible.length ? `<div class="delegate-item-summary"><strong>${eligible.length} Lot ที่มอบหมายได้</strong><small>${selectedMode ? 'ติ๊กเลือกรายการด้านล่าง' : 'ระบบจะเลือกทั้งหมด'}</small></div>${eligible.map(x=>`<label class="delegate-item-option"><input type="checkbox" value="${esc(x.item_id)}" ${selectedMode?'':'checked disabled'}><span><strong>${esc(x.material_name)}</strong><small>${esc(lotKey(x))} · ${qty(x.current_balance)} ${esc(x.unit)}</small></span></label>`).join('')}` : '<div class="empty">ไม่มีรายการที่มอบหมายได้</div>';
  };
  ownerInput?.addEventListener('change', drawItems);
  $$('input[name="delegateScope"]', $('#modalBody')).forEach(r=>r.addEventListener('change',drawItems));
  drawItems();
  $('#weeklyDelegateForm').addEventListener('submit', async e => {
    e.preventDefault();
    const ownerEmail = adminMode ? ownerInput?.value : profile.email;
    const eligible = eligibleForOwner(ownerEmail);
    const selectedMode = document.querySelector('input[name="delegateScope"]:checked')?.value === 'selected';
    const ids = selectedMode ? $$(`#delegateItemList input[type="checkbox"]:checked`).map(x=>x.value) : eligible.map(x=>x.item_id);
    const target = $('#delegateTarget').value;
    const reason = $('#delegateReason').value;
    const detail = $('#delegateDetail').value.trim();
    if (!ids.length) return toast('กรุณาเลือกรายการอย่างน้อย 1 Lot', true);
    if (!target) return toast('กรุณาเลือกผู้ตรวจแทน', true);
    if (!reason) return toast('กรุณาเลือกเหตุผล', true);
    const btn=e.submitter; btn.disabled=true;
    const {error}=await sb.rpc('fn_delegate_weekly_items',{p_item_ids:ids,p_to_email:target,p_reason:detail?`${reason} — ${detail}`:reason,p_acting_mode:actingMode});
    btn.disabled=false;
    if(error)return toast(errMsg(error),true);
    closeModal();
    toast(adminMode ? `มอบหมาย ${ids.length} Lot แล้ว` : `ส่งคำขอฝากตรวจ ${ids.length} Lot แล้ว`);
    renderWeekly();
  });
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
  const staff = staffRes.data || [];
  const items = (data || []).filter(x => x.checked_at || !isExpired(x) || requiresExpiryConfirmation(x));
  window._weeklyItems = items;
  window._weeklyStaff = staff;
  const done = items.filter(x => x.checked_at).length;
  const pct = items.length ? Math.round(done * 100 / items.length) : 100;
  const expiredPending = items.filter(x => !x.checked_at && requiresExpiryConfirmation(x)).length;
  const delegatedToMe = items.filter(x => !x.checked_at && ['ACCEPTED','ADMIN_ASSIGNED'].includes(String(x.delegation_status || '').toUpperCase()) && weeklyDelegatedEmail(x) === String(profile.email || '').toLowerCase()).length;
  const incomingRequests = items.filter(x => !x.checked_at && weeklyDelegationWaiting(x) && weeklyDelegatedEmail(x) === String(profile.email || '').toLowerCase()).length;
  const ownerSet = new Map();
  items.forEach(i => { if (i.responsible_email && !ownerSet.has(i.responsible_email)) ownerSet.set(i.responsible_email, i.responsible_name || i.responsible_email); });
  const ownerEntries=[...ownerSet.entries()].sort((a,b)=>String(a[1]).localeCompare(String(b[1]), 'th'));
  if (isAdminMode() && weeklyAdminActingForEmail && !ownerSet.has(weeklyAdminActingForEmail)) weeklyAdminActingForEmail='';
  const ownerSelect = ['<option value="mine">ของฉัน</option>', '<option value="all">ทุกคน</option>'].concat(ownerEntries.map(([email, name]) => `<option value="${esc(email)}">${esc(name)}</option>`)).join('');
  const adminActingPanel = isAdminMode() ? `<section class="card admin-weekly-acting"><div class="admin-weekly-acting-copy"><span>${icon('user')}</span><div><p class="eyebrow">Admin acting</p><h3>ตรวจแทนเจ้าหน้าที่</h3><p>เลือกชื่อเจ้าของงานก่อนกดตรวจ ระบบจะเก็บชื่อ Admin เป็นผู้ตรวจจริง</p></div></div><label>กำลังทำแทน<select id="adminWeeklyActingFor"><option value="">เลือกชื่อเจ้าหน้าที่</option>${ownerEntries.map(([email,name])=>`<option value="${esc(email)}" ${email===weeklyAdminActingForEmail?'selected':''}>${esc(name)}</option>`).join('')}</select></label><button class="secondary" type="button" data-open-weekly-delegate>มอบหมายให้คนอื่น</button></section>` : '';

  page.innerHTML = `<div class="page-head"><div><h2>ตรวจสต๊อกวันศุกร์</h2><p class="muted small">รอบวันที่ ${d(check.week_friday)}</p></div><div class="weekly-head-actions"><button class="mini ghost" data-route="weekly-status">${icon('user')} สถานะผู้ตรวจ</button><button class="mini" type="button" data-open-weekly-delegate>${isAdminMode()?'มอบหมายผู้ตรวจแทน':'ฝากเพื่อนตรวจแทน'}</button></div></div>${adminActingPanel}
  <section class="card weekly-header"><div class="weekly-ring small-ring" style="--pct:${pct}"><div><strong>${pct}%</strong><span>${done}/${items.length}</span></div></div><div><h3>ความคืบหน้า</h3><p class="muted">ยังไม่ตรวจ ${items.length-done} Lot · หมดอายุรอยืนยัน ${expiredPending} Lot${delegatedToMe?` · ได้รับฝาก ${delegatedToMe} Lot`:''}${incomingRequests?` · รอตอบรับ ${incomingRequests} คำขอ`:''}</p></div></section>
  ${weeklyDelegationPanels(items)}
  <div class="weekly-tools"><label>กรองเจ้าหน้าที่<select id="weeklyOwnerFilter">${ownerSelect}</select></label><div class="filters horizontal-scroller" style="margin-bottom:0"><button class="chip active" data-wf="pending">ยังไม่ตรวจ</button><button class="chip" data-wf="mine">งานของฉัน</button><button class="chip" data-wf="received">งานที่ได้รับฝาก${delegatedToMe?` ${delegatedToMe}`:''}</button><button class="chip" data-wf="expired">หมดอายุ</button><button class="chip" data-wf="mismatch">ไม่ตรง</button><button class="chip" data-wf="done">ตรวจแล้ว</button><button class="chip" data-wf="all">ทั้งหมด</button></div></div><div id="checkList" class="list"></div>${check.status !== 'COMPLETED' && isAdminMode() ? '<button id="completeCheck" class="primary wide-action">เสร็จสิ้นและปิดรอบตรวจ</button>' : ''}`;

  let f = 'pending';
  const ownerFilter = $('#weeklyOwnerFilter');
  ownerFilter.value = isAdminMode() ? (weeklyAdminActingForEmail || 'all') : 'mine';
  const draw = () => {
    let arr = items;
    const owner = ownerFilter.value;
    if (owner === 'mine') arr = arr.filter(x => weeklyOwnerEmail(x) === String(profile.email || '').toLowerCase() || String(x.checked_by_email || '').toLowerCase() === String(profile.email || '').toLowerCase());
    else if (owner !== 'all') arr = arr.filter(x => weeklyOwnerEmail(x) === String(owner).toLowerCase());
    if (f === 'mine') arr = arr.filter(x => weeklyOwnerEmail(x) === String(profile.email || '').toLowerCase());
    if (f === 'received') arr = arr.filter(x => weeklyDelegatedEmail(x) === String(profile.email || '').toLowerCase() && ['PENDING','ACCEPTED','ADMIN_ASSIGNED','COMPLETED'].includes(String(x.delegation_status || '').toUpperCase()));
    if (f === 'pending') arr = arr.filter(x => !x.checked_at);
    if (f === 'expired') arr = arr.filter(x => requiresExpiryConfirmation(x) || x.result === 'EXPIRED_REMOVED');
    if (f === 'mismatch') arr = arr.filter(x => x.result === 'ADJUSTED');
    if (f === 'done') arr = arr.filter(x => x.checked_at);
    $('#checkList').innerHTML = arr.map(weeklyItemCard).join('') || '<div class="card empty">ไม่มีรายการตามตัวกรองนี้</div>';
  };
  ownerFilter.addEventListener('change', draw);
  $$('[data-wf]').forEach(b => b.addEventListener('click', () => { f=b.dataset.wf; $$('[data-wf]').forEach(x=>x.classList.toggle('active',x===b)); draw(); }));
  const adminSelect=$('#adminWeeklyActingFor');
  if(adminSelect) adminSelect.addEventListener('change',()=>{
    weeklyAdminActingForEmail=adminSelect.value;
    ownerFilter.value=weeklyAdminActingForEmail || 'all';
    f='pending';
    $$('[data-wf]').forEach(x=>x.classList.toggle('active',x.dataset.wf==='pending'));
    draw();
    if(weeklyAdminActingForEmail) toast(`กำลังตรวจแทน ${adminSelect.options[adminSelect.selectedIndex].text}`);
  });
  $$('[data-open-weekly-delegate]').forEach(btn=>btn.addEventListener('click',()=>openWeeklyDelegateModal(items,staff,check)));
  $$('[data-delegation-response]').forEach(btn=>btn.addEventListener('click',async()=>{
    const accept=btn.dataset.delegationResponse==='accept'; btn.disabled=true;
    const {error}=await sb.rpc('fn_respond_weekly_delegation',{p_batch_id:btn.dataset.delegationBatch,p_accept:accept});
    if(error){btn.disabled=false;return toast(errMsg(error),true);} toast(accept?'รับงานตรวจแทนแล้ว':'ปฏิเสธคำขอแล้ว'); renderWeekly();
  }));
  $$('[data-delegation-cancel]').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!confirm('ยกเลิกการมอบหมายรายการนี้หรือไม่'))return; btn.disabled=true;
    const {error}=await sb.rpc('fn_cancel_weekly_delegation',{p_batch_id:btn.dataset.delegationCancel,p_acting_mode:actingMode});
    if(error){btn.disabled=false;return toast(errMsg(error),true);} toast('ยกเลิกการมอบหมายแล้ว'); renderWeekly();
  }));
  draw();
  if ($('#completeCheck')) $('#completeCheck').onclick = async () => {
    const {error} = await sb.rpc('fn_complete_weekly_check', {p_check_id:check.id, p_acting_mode:actingMode});
    if (error) return toast(errMsg(error), true);
    toast('ปิดรอบตรวจสต๊อกแล้ว'); renderWeekly();
  };
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
      if(!people.has(email))people.set(email,{name:r.assigned_name||'ยังไม่กำหนด',rounds:0,done:0,missed:0,pending:0,delegated:0,delegationPending:0});
      const p=people.get(email);p.rounds++;p.pending+=Number(r.pending_items||0);p.delegated+=Number(r.delegated_out_items??r.checked_by_other_items??0);p.delegationPending+=Number(r.delegation_pending_items||0);if(Number(r.pending_items||0)>0)p.missed++;else p.done++;
      const week=r.week_friday;if(!weeks.has(week))weeks.set(week,[]);weeks.get(week).push(r);
    });
    const peopleHtml=[...people.values()].sort((a,b)=>b.missed-a.missed||a.name.localeCompare(b.name,'th')).map(p=>`<article><strong>${esc(p.name)}</strong><span>ครบ ${p.done}/${p.rounds} สัปดาห์</span><em class="${p.missed?'danger-text':'ok-text'}">ไม่ครบ ${p.missed}</em>${p.delegated?`<small>มอบหมายผู้ตรวจแทน ${p.delegated} Lot</small>`:''}${p.delegationPending?`<small class="warn-text">รอยืนยัน ${p.delegationPending} Lot</small>`:''}</article>`).join('');
    const weekHtml=[...weeks.entries()].map(([week,items])=>{const pending=items.filter(x=>Number(x.pending_items||0)>0),done=items.filter(x=>Number(x.pending_items||0)===0&&Number(x.total_items||0)>0);return `<details class="weekly-round-card"><summary><strong>ศุกร์ ${d(week)}</strong><span>${done.length}/${items.length} คนครบ</span></summary><div class="weekly-round-columns"><div><h4>ยังไม่ครบ (${pending.length})</h4>${pending.map(x=>`<p><strong>${esc(x.assigned_name)}</strong><span>เหลือ ${qty(x.pending_items)} Lot</span></p>`).join('')||'<p class="ok-text">ทุกคนตรวจครบ</p>'}</div><div><h4>ตรวจครบแล้ว (${done.length})</h4>${done.map(x=>`<p><strong>${esc(x.assigned_name)}</strong><span>${qty(x.checked_items)}/${qty(x.total_items)} Lot</span></p>`).join('')||'<p class="muted">ยังไม่มี</p>'}</div></div></details>`;}).join('');
    $('#weeklyStatusResult').innerHTML=`<section class="card"><div class="section-title compact"><h3>สรุปตามเจ้าหน้าที่</h3><span class="badge info">${weeks.size} สัปดาห์</span></div><div class="weekly-staff-summary-grid">${peopleHtml||'<div class="empty">ไม่มีข้อมูล</div>'}</div></section><section class="weekly-round-list"><div class="section-title"><h3>รายละเอียดแต่ละวันศุกร์</h3></div>${weekHtml||'<div class="card empty">ไม่มีข้อมูลในช่วงวันที่เลือก</div>'}</section>`;
  };
  $('#weeklyStatusForm').addEventListener('submit',e=>{e.preventDefault();load();});
  await load();
}

function weeklyActingForEmail(x) {
  if (!isAdminMode()) return null;
  return weeklyAdminActingForEmail || x?.responsible_email || null;
}

function weeklyActingContextMarkup(x) {
  const owner = x?.responsible_name || x?.responsible_email || 'ยังไม่กำหนด';
  const actual = profile?.display_name || profile?.email || '-';
  const delegated = weeklyDelegationActive(x) && x?.delegated_to_name
    ? `<span><small>ผู้ได้รับมอบหมาย</small><strong>${esc(x.delegated_to_name)}</strong></span>` : '';
  return `<div class="weekly-acting-context"><span><small>ผู้ดูแลหลัก</small><strong>${esc(owner)}</strong></span>${delegated}<span><small>ผู้ตรวจจริง</small><strong>${esc(actual)}</strong></span></div>`;
}

function openCheck(id) {
  const x = (window._weeklyItems || []).find(i => i.item_id === id);
  if (!x) return;
  if (!canHandleItem(x)) {
    if (isAdminMode() && route === 'weekly' && !weeklyAdminActingForEmail) return toast('กรุณาเลือกชื่อเจ้าหน้าที่ที่ต้องการทำแทนก่อน', true);
    return toast('รายการนี้ยังไม่ได้มอบหมายให้บัญชีของคุณ', true);
  }
  if (isExpired(x)) return openExpiredRemoval(id);
  openModal(`<h3>${esc(x.material_name)}</h3><p class="muted">${esc(lotKey(x))} · ยอดในระบบ ${qty(x.current_balance)} ${esc(x.unit)}</p>${weeklyActingContextMarkup(x)}<div class="check-adjustment-guide">${icon('check')}<div><strong>กรอกจำนวนที่นับได้จริง</strong><span>หากไม่เท่ากับยอดในระบบ ระบบจะปรับยอดคงเหลือให้เท่ากับจำนวนที่กรอก พร้อมเก็บเจ้าของงาน ผู้ตรวจแทน และผู้ตรวจจริงแยกกัน</span></div></div><form id="checkForm" class="form-grid"><label>จำนวนที่นับได้จริง<input id="actualQty" type="number" min="0" step="0.01" value="${Number(x.current_balance)}" required inputmode="decimal"></label><div id="adjustmentPreview" class="adjustment-preview matched">ยอดตรงกับระบบ ยังไม่มีการปรับจำนวน</div><div id="reasonFields" class="form-grid hidden"><label>เหตุผล<select id="reasonCode"><option value="">เลือกเหตุผล</option><option>นำออกแล้วไม่ได้บันทึก</option><option>รับเข้าหรือนำออกผิดจำนวน</option><option>สูญหายหรือหาไม่พบ</option><option>ชำรุด</option><option>นับครั้งก่อนผิด</option><option>Lot หรือสติ๊กเกอร์ไม่ตรง</option><option>อื่น ๆ</option></select></label><label>รายละเอียด<textarea id="reasonDetail" rows="3"></textarea></label></div><button class="primary" type="submit">บันทึกผลตรวจ</button></form>`);
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
    const btn=e.submitter; btn.disabled=true;
    const {error} = await sb.rpc('fn_save_stock_check', {
      p_item_id:id,
      p_actual_qty:actual,
      p_reason_code:diff ? $('#reasonCode').value : null,
      p_reason_detail:diff ? $('#reasonDetail').value.trim() || null : null,
      p_acting_mode:actingMode,
      p_acting_for_email:weeklyActingForEmail(x)
    });
    btn.disabled=false;
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
  if (!canHandleItem(x)) {
    if (isAdminMode() && route === 'weekly' && !weeklyAdminActingForEmail) return toast('กรุณาเลือกชื่อเจ้าหน้าที่ที่ต้องการทำแทนก่อน', true);
    return toast('รายการนี้ยังไม่ได้มอบหมายให้บัญชีของคุณ', true);
  }
  openModal(`<h3>ยืนยันนำ Lot หมดอายุออกจากพื้นที่</h3>${weeklyActingContextMarkup(x)}<div class="expired-confirm-card"><strong>${esc(x.material_name)}</strong><span>${esc(lotKey(x))}</span><span>EXP ${d(x.expiry_date)} · คงเหลือในระบบ ${qty(x.current_balance)} ${esc(x.unit)}</span></div><form id="expiredForm" class="form-grid"><label class="confirm-check"><input id="expiredConfirm" type="checkbox" required><span>ตรวจแล้วว่า Lot นี้ถูกนำออกจากชั้น/ตู้/พื้นที่ใช้งานจริง</span></label><label>หมายเหตุ<textarea id="expiredNote" rows="3" placeholder="เช่น นำไปจุดพักของหมดอายุแล้ว"></textarea></label><p class="notice">เมื่อยืนยัน ระบบจะตัดยอดเป็น 0 ปิด Lot และสัปดาห์หน้าจะไม่ต้องตรวจซ้ำ</p><button class="danger" type="submit">${icon('check')} ยืนยันนำออกจากพื้นที่แล้ว</button></form>`);
  $('#expiredForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!$('#expiredConfirm').checked) return toast('กรุณายืนยันว่าได้นำออกจากพื้นที่จริงแล้ว', true);
    const btn = e.submitter;
    btn.disabled = true;
    const {error} = await sb.rpc('fn_confirm_expired_removal', {
      p_item_id:id,
      p_note:$('#expiredNote').value.trim() || null,
      p_acting_mode:actingMode,
      p_acting_for_email:weeklyActingForEmail(x)
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
    else if(type==='check')q=q.in('action',['STOCK_CHECK_MATCHED','STOCK_CHECK_ADJUSTED','WEEKLY_CHECK_COMPLETED','WEEKLY_DELEGATION_REQUESTED','WEEKLY_DELEGATION_ADMIN_ASSIGNED','WEEKLY_DELEGATION_ACCEPTED','WEEKLY_DELEGATION_REJECTED','WEEKLY_DELEGATION_CANCELLED']);
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

function reportTxType(kind) {
  return kind === 'receive' ? 'RECEIVE' : kind === 'issue' ? 'ISSUE' : 'EXPIRED';
}

function cleanReportSearch(value) {
  return String(value || '').replace(/[,%()]/g, ' ').replace(/\s+/g, ' ').trim();
}

function dateTimeLocalToIso(value) {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function applyReportFilters(query, txType, filters = {}) {
  const from = dateTimeLocalToIso(filters.from);
  const to = dateTimeLocalToIso(filters.to);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);
  const product = cleanReportSearch(filters.product);
  const lot = cleanReportSearch(filters.lot);
  const recorder = cleanReportSearch(filters.recorder);
  if (product) query = query.ilike('material_name', `%${product}%`);
  if (lot) query = query.ilike('lot_key', `%${lot}%`);
  if (filters.quantity !== '' && filters.quantity !== null && filters.quantity !== undefined) {
    const entered = Number(filters.quantity);
    if (Number.isFinite(entered)) query = query.eq('quantity_delta', txType === 'RECEIVE' ? Math.abs(entered) : -Math.abs(entered));
  }
  if (filters.balance !== '' && filters.balance !== null && filters.balance !== undefined) {
    const balance = Number(filters.balance);
    if (Number.isFinite(balance)) query = query.eq('quantity_after', balance);
  }
  if (txType === 'ISSUE' && filters.method) {
    if (filters.method === 'LEGACY') query = query.is('issue_method', null);
    else query = query.eq('issue_method', filters.method);
  }
  if (recorder) query = query.or(`created_by_name.ilike.%${recorder}%,created_by_email.ilike.%${recorder}%`);
  return query;
}

async function fetchReportPage(kind, filters = {}, pageNumber = 1, pageSize = REPORT_PAGE_SIZE) {
  const txType = reportTxType(kind);
  const pageNo = Math.max(1, Number(pageNumber) || 1);
  const from = (pageNo - 1) * pageSize;
  let query = sb.from('v_transaction_history').select('*', {count:'exact'}).eq('tx_type', txType);
  query = applyReportFilters(query, txType, filters);
  const {data, error, count} = await query.order('created_at', {ascending:false}).order('id', {ascending:false}).range(from, from + pageSize - 1);
  if (error) throw error;
  return {rows:data || [], count:Number(count || 0), page:pageNo, pageSize};
}

async function fetchAllFilteredReportRows(kind, filters = {}, maxRows = 10000) {
  const txType = reportTxType(kind);
  const batchSize = 1000;
  const rows = [];
  for (let from = 0; from < maxRows; from += batchSize) {
    let query = sb.from('v_transaction_history').select('*').eq('tx_type', txType);
    query = applyReportFilters(query, txType, filters);
    const {data, error} = await query.order('created_at', {ascending:false}).order('id', {ascending:false}).range(from, from + batchSize - 1);
    if (error) throw error;
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < batchSize) break;
  }
  return rows;
}

function readReportFilters() {
  return {
    from:$('#rfFrom')?.value || '',
    to:$('#rfTo')?.value || '',
    product:$('#rfProduct')?.value.trim() || '',
    lot:$('#rfLot')?.value.trim() || '',
    quantity:$('#rfQuantity')?.value ?? '',
    balance:$('#rfBalance')?.value ?? '',
    method:$('#rfMethod')?.value || '',
    recorder:$('#rfRecorder')?.value.trim() || ''
  };
}

function reportFilterMarkup(kind) {
  const method = kind === 'issue' ? `<label>วิธีนำออก<select id="rfMethod"><option value="">ทั้งหมด</option><option value="QR_SCAN">สแกน QR</option><option value="MANUAL_ENTRY">พิมพ์รหัสเอง</option><option value="LEGACY">ไม่ระบุ — ข้อมูลเดิม</option></select></label>` : '';
  return `<form id="reportFilterForm" class="card report-filter-card"><div class="report-filter-head"><div><p class="eyebrow">Filter report</p><h3>ตัวกรองรายงาน</h3><p>กรองก่อนโหลด ระบบจะแสดงครั้งละ 10 รายการ</p></div><button class="mini ghost" id="clearReportFilters" type="button">ล้างตัวกรอง</button></div><div class="report-filter-grid"><label>วันเวลาเริ่มต้น<input id="rfFrom" type="datetime-local"></label><label>วันเวลาสิ้นสุด<input id="rfTo" type="datetime-local"></label><label>สินค้า<input id="rfProduct" type="search" placeholder="พิมพ์ชื่อสินค้า"></label><label>Lot<input id="rfLot" type="search" placeholder="พิมพ์ Lot หรือรหัส"></label><label>จำนวน<input id="rfQuantity" type="number" step="0.01" min="0" placeholder="เช่น 1"></label><label>ยอดหลังทำ<input id="rfBalance" type="number" step="0.01" min="0" placeholder="เช่น 20"></label>${method}<label>ผู้บันทึก<input id="rfRecorder" type="search" placeholder="พิมพ์ชื่อผู้บันทึก"></label></div><div class="report-filter-actions"><button class="primary" type="submit">${icon('search')} ค้นหารายงาน</button><span class="muted small">เว้นว่างเพื่อดูรายการล่าสุดทั้งหมด</span></div></form>`;
}

function reportResultMarkup(kind, result) {
  const showIssueMethod = kind === 'issue';
  const totalPages = Math.max(1, Math.ceil(result.count / result.pageSize));
  const first = result.count ? ((result.page - 1) * result.pageSize) + 1 : 0;
  const last = Math.min(result.page * result.pageSize, result.count);
  return `<div class="report-actions"><div><strong>ผลการค้นหา</strong><span class="muted small">${result.count ? `รายการที่ ${first}–${last} จาก ${result.count}` : 'ไม่พบรายการที่ตรงกับตัวกรอง'}</span></div><button class="primary" data-export-report="${kind}">${icon('download')} ส่งออก CSV ตามตัวกรอง</button></div><div class="table-wrap report-table-wrap"><table class="data-table report-table-v145"><thead><tr><th>วันเวลา</th><th>สินค้า</th><th>Lot</th><th>จำนวน</th><th>ยอดหลังทำ</th>${showIssueMethod ? '<th>วิธีนำออก</th>' : ''}<th>ผู้บันทึก</th></tr></thead><tbody>${transactionRows(result.rows, {showIssueMethod}) || `<tr><td colspan="${showIssueMethod ? 7 : 6}" class="empty">ไม่มีรายการ</td></tr>`}</tbody></table></div><div class="table-pagination ${totalPages <= 1 ? 'single' : ''}"><span>หน้า ${Math.min(result.page,totalPages)} จาก ${totalPages} · 10 รายการต่อหน้า</span><div><button class="mini ghost" type="button" data-report-page="${result.page - 1}" ${result.page <= 1 ? 'disabled' : ''}>ก่อนหน้า</button><button class="mini" type="button" data-report-page="${result.page + 1}" ${result.page >= totalPages ? 'disabled' : ''}>ถัดไป</button></div></div>`;
}

async function exportReport(kind) {
  const stamp = new Date().toISOString().slice(0,10);
  if (kind === 'stock') {
    const rows = window._reportStock || [];
    saveCsv(`CNMI_Inventory_Stock_${stamp}.csv`, [['รหัสวัสดุ','ชื่อวัสดุ','Lot','วันหมดอายุ','คงเหลือ','หน่วย','ผู้ดูแล','สถานะ','รหัสเดิมที่สแกนได้'], ...rows.map(x => [x.material_code,x.material_name,x.lot_no,x.expiry_date || '',x.balance,x.unit,x.responsible_name || '',isExpired(x)?'หมดอายุรอนำออก':'ใช้งาน',pgArray(x.legacy_lot_keys).join(' | ')])]);
    toast('ส่งออกสต๊อกตาม Lot แล้ว');
    return;
  }
  if (kind === 'minimum-stock') {
    let summaries = window._reportMinimumStock || [];
    if (!summaries.length) summaries = await ensureInventorySummary();
    const groups = buildMaterialGroups(summaries, []);
    const rows = groups.map(g => {
      const mode = g.alert_mode || 'MINIMUM';
      const status = materialGroupStatus(g).label;
      const shortage = mode === 'MINIMUM' ? Math.max(Number(g.min_qty || 0) - Number(g.total_balance || 0), 0) : '';
      const modeLabel = mode === 'MONTHLY' ? 'เตือนรอบเบิกรายเดือน' : mode === 'NONE' ? 'ไม่เปิดแจ้งเตือน' : 'เตือนตามจำนวนขั้นต่ำ';
      return [
        g.material_code,
        g.material_name,
        Number(g.total_balance || 0),
        Number(g.min_qty || 0),
        shortage,
        g.unit,
        modeLabel,
        mode === 'MONTHLY' ? Number(g.reorder_day || 1) : '',
        expiryAlertMonths(g),
        g.responsible_name || '',
        status,
        Number(g.active_lots || 0),
        g.nearest_expiry || ''
      ];
    });
    saveCsv(`CNMI_Inventory_Minimum_Stock_${stamp}.csv`, [[
      'รหัสวัสดุ','ชื่อวัสดุ','คงเหลือรวม','Minimum Stock','จำนวนที่ขาดจากขั้นต่ำ','หน่วย',
      'รูปแบบแจ้งเตือน','วันที่เตือนรายเดือน','เตือนใกล้หมดอายุล่วงหน้า (เดือน)','ผู้ดูแล','สถานะ','จำนวน Lot ที่ใช้งาน','วันหมดอายุใกล้สุด'
    ], ...rows]);
    toast(`ส่งออก Minimum Stock แล้ว ${rows.length.toLocaleString('th-TH')} รายการ`);
    return;
  }
  const context = window._reportContext || {};
  const filters = context.kind === kind ? context.filters || {} : {};
  toast('กำลังจัดเตรียม CSV ตามตัวกรอง…');
  const rows = await fetchAllFilteredReportRows(kind, filters);
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
  toast(`ส่งออก CSV แล้ว ${rows.length.toLocaleString('th-TH')} รายการ`);
}

async function renderReports(defaultTab = '') {
  page.innerHTML = `<div class="page-head report-page-head"><div><p class="eyebrow">Reports</p><h2>รายงาน & ส่งออก</h2><p class="muted small">เลือกประเภทและกรองข้อมูลก่อน ระบบจะแสดงครั้งละ 10 รายการ</p></div></div><div class="tabs report-tabs premium-tabs"><button data-report-tab="receive">นำเข้า</button><button data-report-tab="issue">นำออก</button><button data-report-tab="expired">หมดอายุ</button><button data-report-tab="stock">สต๊อกคงเหลือ</button></div><div id="reportPane"><div class="card select-first-state">${icon('download')}<div><strong>กรุณาเลือกประเภทรายงาน</strong><span>ยังไม่มีการโหลดข้อมูล</span></div></div></div>`;
  const draw = async tab => {
    reportTab = tab;
    $$('[data-report-tab]').forEach(x => x.classList.toggle('active', x.dataset.reportTab === tab));
    $('#reportPane').innerHTML='<div class="card usage-loading">กำลังเปิดรายงานที่เลือก…</div>';
    if (tab === 'stock') {
      const [lots,summaries]=await Promise.all([getLots(true),ensureInventorySummary()]);
      window._reportStock=lots;
      window._reportMinimumStock=summaries;
      $('#reportPane').innerHTML = `<section class="card report-result-card"><div class="report-actions"><div><strong>สต๊อกคงเหลือปัจจุบัน</strong><span class="muted small">${lots.length} Lot ที่ยัง Active · Minimum Stock ${summaries.length} รายการวัสดุ</span></div><div class="actions" style="margin-top:0"><button class="secondary" data-export-report="minimum-stock">${icon('download')} Export Minimum Stock</button><button class="primary" data-export-report="stock">${icon('download')} ส่งออกสต๊อกตาม Lot</button></div></div><div class="notice report-minimum-note"><strong>ไฟล์ Minimum Stock</strong><span>สรุปหนึ่งแถวต่อวัสดุ พร้อมยอดคงเหลือ ขั้นต่ำ จำนวนที่ขาด ผู้ดูแล สถานะ และวันหมดอายุใกล้สุด</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>สินค้า</th><th>Lot</th><th>คงเหลือ</th><th>EXP</th><th>ผู้ดูแล</th><th>สถานะ</th></tr></thead><tbody>${lots.map(x => `<tr><td><strong>${esc(x.material_name)}</strong></td><td>${esc(lotKey(x))}</td><td>${qty(x.balance)} ${esc(x.unit)}</td><td>${d(x.expiry_date)}</td><td>${esc(x.responsible_name || '-')}</td><td>${statusBadge(x)}</td></tr>`).join('')}</tbody></table></div></section>`;
      queueResponsiveTables($('#reportPane'));
      return;
    }

    $('#reportPane').innerHTML = `<div class="report-layout-v145">${reportFilterMarkup(tab)}<section class="card report-result-card" id="reportResults"><div class="usage-loading">กำลังโหลด 10 รายการล่าสุด…</div></section></div>`;
    let currentPage = 1;
    let activeFilters = {};

    const loadPage = async (pageNumber = 1) => {
      const results = $('#reportResults');
      if (!results) return;
      results.innerHTML = '<div class="usage-loading">กำลังค้นหารายงาน…</div>';
      try {
        const result = await fetchReportPage(tab, activeFilters, pageNumber);
        currentPage = result.page;
        window._reportRows = result.rows;
        window._reportContext = {kind:tab, filters:{...activeFilters}, count:result.count};
        results.innerHTML = reportResultMarkup(tab, result);
        queueResponsiveTables(results);
        results.querySelectorAll('[data-report-page]').forEach(button => button.addEventListener('click', async () => {
          const target = Number(button.dataset.reportPage || 1);
          if (target < 1 || target === currentPage) return;
          button.disabled = true;
          await loadPage(target);
          results.scrollIntoView({behavior:'smooth',block:'start'});
        }));
      } catch (e) {
        results.innerHTML = `<div class="notice">${esc(errMsg(e))}</div>`;
      }
    };

    $('#reportFilterForm').addEventListener('submit', async e => {
      e.preventDefault();
      activeFilters = readReportFilters();
      await loadPage(1);
    });
    $('#clearReportFilters').addEventListener('click', async () => {
      $('#reportFilterForm').reset();
      activeFilters = {};
      await loadPage(1);
    });
    await loadPage(1);
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
  page.innerHTML = `<div class="page-head"><div><h2>ตั้งค่าผู้ดูแลระบบ</h2><p class="muted small">เปลี่ยนคนดูแลวัสดุได้ตลอด และกำหนดสิทธิ์ผู้ใช้</p></div><span class="badge info">โหมด Admin</span></div><section class="admin-note"><strong>การทำงาน 2 โหมด</strong><p>บัญชี Admin สามารถสลับเป็น “เจ้าหน้าที่” เพื่อทำงานเหมือนทุกคน หรือ “ผู้ดูแลระบบ” เมื่อต้องตั้งค่าและดูงานรวม</p></section><div class="section-title"><h3>ผู้ใช้งาน</h3></div><div class="table-wrap"><table class="data-table"><thead><tr><th>ชื่อ</th><th>อีเมล</th><th>สิทธิ์บัญชี</th></tr></thead><tbody>${(s || []).map(x => `<tr><td>${esc(x.display_name)}</td><td>${esc(x.email)}</td><td><select data-role-email="${esc(x.email)}"><option value="staff" ${x.role === 'staff' ? 'selected' : ''}>เจ้าหน้าที่</option><option value="admin" ${x.role === 'admin' ? 'selected' : ''}>Admin (สลับได้ 2 โหมด)</option></select></td></tr>`).join('')}</tbody></table></div><div class="section-title admin-owner-head"><div><h3>กำหนดผู้ดูแลหลักและผู้ช่วยดูแล</h3><p class="muted small">ทั้งสองคนเห็นรายการและช่วยตรวจวันศุกร์ได้</p></div><div class="search-box">${icon('search')}<input id="adminMaterialSearch" placeholder="ค้นหารหัส ชื่อ หรือผู้ดูแล"></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>รหัส</th><th>ชื่อวัสดุ</th><th>ขั้นต่ำ</th><th>เตือน EXP</th><th>ผู้ดูแลหลัก</th><th>ผู้ช่วยดูแล</th><th>จัดการ</th></tr></thead><tbody id="adminMaterialBody"></tbody></table></div>`;
  const drawMaterials = () => {
    const q = $('#adminMaterialSearch').value.toLowerCase();
    const arr = (m || []).filter(x => !q || `${x.code} ${x.name} ${x.responsible_email} ${x.assistant_responsible_email || ''}`.toLowerCase().includes(q));
    $('#adminMaterialBody').innerHTML = arr.map(x => `<tr><td>${esc(x.code)}</td><td><strong>${esc(x.name)}</strong><div class="muted tiny">ชื่อบนสติ๊กเกอร์: ${esc(x.label_name || x.name)}</div></td><td>${qty(x.min_qty)} ${esc(x.unit)}</td><td>${expiryAlertMonths(x)} เดือน</td><td><select data-owner-code="${esc(x.code)}">${ownerOptions(s, x.responsible_email || '')}</select></td><td><select data-assistant-owner-code="${esc(x.code)}">${ownerOptions(s, x.assistant_responsible_email || '')}</select></td><td><button class="mini" data-edit-material="${esc(x.code)}">แก้ไข</button></td></tr>`).join('');
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
    toast('เปลี่ยนผู้ดูแลหลักแล้ว มีผลกับตรวจวันศุกร์ทันที');
  }));
  $$('[data-assistant-owner-code]').forEach(sel => sel.addEventListener('change', async () => {
    const row = (window._adminMaterials || []).find(x => x.code === sel.dataset.assistantOwnerCode);
    if (row?.responsible_email && sel.value === row.responsible_email) {
      sel.value = row.assistant_responsible_email || '';
      return toast('ผู้ดูแลหลักกับผู้ช่วยดูแลต้องเป็นคนละคน', true);
    }
    const {error} = await sb.from('materials').update({assistant_responsible_email: sel.value || null}).eq('code', sel.dataset.assistantOwnerCode);
    if (error) return toast(errMsg(error), true);
    stockCache = []; scanLotsCache=[]; scanLotsLoadedAt=0; materialsCache = [];
    if (row) row.assistant_responsible_email = sel.value || null;
    toast('เปลี่ยนผู้ช่วยดูแลแล้ว');
  }));
}

function openMaterialEditor(code) {
  const x = (window._adminMaterials || []).find(m => m.code === code);
  const staff = window._adminStaff || [];
  if (!x) return;
  openModal(`<h3>${esc(x.code)} · ${esc(x.name)}</h3><form id="matForm" class="form-grid"><label>ชื่อบนสติ๊กเกอร์<input id="matLabel" maxlength="80" value="${esc(x.label_name || x.name)}"></label><label>จำนวนขั้นต่ำ<input id="matMin" type="number" min="0" step="0.01" value="${Number(x.min_qty || 0)}"></label><label>แจ้งใกล้หมดอายุล่วงหน้า<select id="matExpiryAlert"><option value="1" ${expiryAlertMonths(x)===1?'selected':''}>1 เดือน — รายการทั่วไป</option><option value="8" ${expiryAlertMonths(x)===8?'selected':''}>8 เดือน — ต้องเคลมหรือจัดการล่วงหน้า</option></select></label><label>ผู้ดูแลหลัก<select id="matOwner">${ownerOptions(staff, x.responsible_email || '')}</select></label><label>ผู้ช่วยดูแล<select id="matAssistantOwner">${ownerOptions(staff, x.assistant_responsible_email || '')}</select></label><button class="primary" type="submit">บันทึก</button></form>`);
  $('#matForm').addEventListener('submit', async e => {
    e.preventDefault();
    const {error} = await sb.from('materials').update({
      label_name:$('#matLabel').value.trim(),
      min_qty:Number($('#matMin').value),
      expiry_alert_months:Number($('#matExpiryAlert').value || DEFAULT_EXPIRY_ALERT_MONTHS),
      responsible_email:$('#matOwner').value || null,
      assistant_responsible_email:$('#matAssistantOwner').value || null
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
  page.innerHTML = `<div class="page-head"><div><h2>คู่มือย่อ</h2><p class="muted small">CNMI Inventory v${APP_VERSION}</p></div></div><section class="card help-install-card"><div class="help-install-copy"><span class="install-panel-icon">${icon('smartphone')}</span><div><h3>ติดตั้ง CNMI Inventory บนโทรศัพท์</h3><p data-install-status>เลือก Android หรือ iPhone/iPad</p></div></div><div class="install-actions help-install-actions"><button class="install-platform-btn android" type="button" data-install-platform="android">${icon('download')}<span><b>ติดตั้ง Android</b><small data-install-label>ผ่าน Chrome</small></span></button><button class="install-platform-btn ios" type="button" data-install-platform="ios">${icon('share')}<span><b>ติดตั้ง iOS</b><small data-install-label>เปิดคู่มือ Safari</small></span></button></div></section><div class="grid help-grid"><div class="card help-card"><h3>สร้างบัญชีครั้งแรก</h3><ol class="help-steps"><li>ใช้เฉพาะอีเมลมหิดล @mahidol.ac.th ที่ Admin อนุญาตไว้</li><li>ตั้งรหัสผ่านสำหรับแอปอย่างน้อย 6 ตัว</li><li>กด “สร้างบัญชีครั้งแรก” แล้วกด “เข้าสู่ระบบ” ด้วยข้อมูลเดิม</li></ol></div><div class="card help-card"><h3>รับเข้าและพิมพ์ QR</h3><ol class="help-steps"><li>เปิดเมนู นำเข้า</li><li>พิมพ์ชื่อวัสดุบางส่วนแล้วเลือกจากรายการ</li><li>ตรวจชื่อผู้นำเข้าปัจจุบัน ใส่ Lot วันหมดอายุ และจำนวน แล้วบันทึก</li></ol></div><div class="card help-card"><h3>นำออก</h3><ol class="help-steps"><li>สแกน QR Sticker หรือพิมพ์รหัส Lot</li><li>ตรวจชื่อสินค้าและวิธีนำออก แล้วกด “ยืนยันนำออก 1 หน่วย”</li><li>ระบบบันทึกแยกเป็น “สแกน QR” หรือ “พิมพ์รหัสเอง” ในประวัติและรายงาน</li></ol></div><div class="card help-card"><h3>สต๊อกที่ฉันดูแล</h3><p>มี 3 เมนูย่อย: ภาพรวม, ต้องเบิก และตั้งค่าการเตือน เลือกเตือนตามจำนวนขั้นต่ำ เตือนรอบเบิกรายเดือน หรือไม่แจ้งเตือนได้ และกำหนดเกณฑ์ใกล้หมดอายุแยกต่อวัสดุเป็น 1 เดือนหรือ 8 เดือน การเตือนรายเดือนจะเริ่มตรวจรอบตั้งแต่เดือนถัดไปหลังบันทึก</p></div><div class="card help-card"><h3>ตรวจวันศุกร์</h3><p>กรอกจำนวนที่นับได้จริง หากไม่ตรงกับระบบ ให้เลือกเหตุผล สามารถฝากเพื่อนตรวจแทนเฉพาะรอบได้ ผู้รับต้องกดยืนยันก่อน ส่วน Admin เลือกชื่อเจ้าหน้าที่เพื่อทำแทนหรือมอบหมายให้คนอื่นได้ทันที ระบบเก็บผู้ดูแลหลัก ผู้ได้รับมอบหมาย และผู้ตรวจจริงแยกกัน</p></div><div class="card help-card"><h3>สแกนตรวจ Lot</h3><p>เปิดกล้องหรือพิมพ์รหัส QR เพื่อดูยอด Lot ยอดรวม ผู้ดูแล ขั้นต่ำ และยืนยันตรวจหรือปรับยอดได้ทันที</p></div><div class="card help-card"><h3>สถานะผู้ตรวจ</h3><p>เปิดเมนู “สถานะผู้ตรวจ” แล้วกำหนดช่วงวันที่ เพื่อดูว่าแต่ละวันศุกร์ใครตรวจครบหรือยังไม่ครบ</p></div><div class="card help-card"><h3>สติ๊กเกอร์เดิม</h3><p>สติ๊กเกอร์รหัสเดิมยังสแกนได้ ไม่ต้องเปลี่ยนใหม่ทั้งหมด</p></div><div class="card help-card"><h3>ของหมดอายุ</h3><p>ระบบไม่ตัดยอดเอง เปิดตรวจวันศุกร์และกด “ยืนยันนำออก” หลังตรวจว่าเอาออกจากพื้นที่จริงแล้ว จากนั้น Lot จะถูกปิดและไม่แสดงในสัปดาห์ถัดไป</p></div><div class="card help-card"><h3>ข้อมูลเดิม In / Out</h3><p>ประวัติจาก Excel เดิมดูได้ในหน้าประวัติและรายงาน</p></div><div class="card help-card"><h3>พิมพ์สติ๊กเกอร์ภายหลัง</h3><p>หลังรับเข้าผ่านโทรศัพท์ ให้เปิดเมนู “พิมพ์สติ๊กเกอร์” บนคอมพิวเตอร์ที่ต่อเครื่องพิมพ์ รายการรับเข้าจะอยู่ในคิวอัตโนมัติ เลือกจำนวนดวงแล้วกด “พิมพ์สติ๊กเกอร์” จากนั้นเลือกเครื่องพิมพ์ใน Chrome</p></div><div class="card help-card"><h3>เครื่องพิมพ์สติ๊กเกอร์</h3><p>ฉลากจริง 25 × 20 mm ระบบใช้รูปแบบสติ๊กเกอร์มาตรฐานเดียวกันทุกเครื่อง พร้อม QR ขนาดใหญ่และขอบขาวมาตรฐาน ในหน้าพิมพ์ Chrome ให้เลือกเครื่องพิมพ์และตั้งกระดาษตามเครื่องที่ใช้งาน ใช้ Scale 100% หรือ Actual size ปิด Header/Footer และใช้ Margin None</p></div></div>`;
  refreshInstallUI();
}

init();
})();
