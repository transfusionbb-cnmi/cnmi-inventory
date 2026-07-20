(() => {
'use strict';

const C = window.APP_CONFIG || {};
const configured = C.SUPABASE_URL && !C.SUPABASE_URL.includes('YOUR-PROJECT') && C.SUPABASE_ANON_KEY && !C.SUPABASE_ANON_KEY.includes('YOUR-ANON');
let sb = null;
let session = null;
let profile = null;
let route = 'home';
let moveTab = 'receive';
let stockCache = [];
let materialsCache = [];
let autoExpiryRan = false;
let scannerStream = null;
let scannerTimer = null;
let pendingIssueCode = new URLSearchParams(location.search).get('issue') || new URLSearchParams(location.search).get('lot');

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

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.background = bad ? '#b42318' : '#17201f';
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

function openModal(html) {
  stopScanner();
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
  $('#modal').setAttribute('aria-hidden', 'false');
}

function closeModal() {
  stopScanner();
  $('#modal').classList.add('hidden');
  $('#modal').setAttribute('aria-hidden', 'true');
  $('#modalBody').innerHTML = '';
}

function loading() {
  page.innerHTML = '<div class="grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
}

function errMsg(e) {
  return e?.message || String(e || 'เกิดข้อผิดพลาด');
}

function todayStart() {
  const x = new Date();
  x.setHours(0, 0, 0, 0);
  return x;
}

function isExpired(x) {
  return Boolean(x?.expiry_date && new Date(x.expiry_date + 'T00:00:00') < todayStart());
}

function lotKey(l) {
  return l?.lot_key || `${l?.material_code || l?.stock_code || ''}-${l?.lot_no || ''}`;
}

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if ($('#staffPlannerLink') && C.STAFF_PLANNER_URL) $('#staffPlannerLink').href = C.STAFF_PLANNER_URL;

  $('#modal').addEventListener('click', e => {
    if (e.target.id === 'modal' || e.target.closest('.modal-close')) closeModal();
  });
  $('#loginForm').addEventListener('submit', login);
  $('#registerBtn').addEventListener('click', register);
  $('#logoutBtn').addEventListener('click', logout);
  document.addEventListener('click', globalClick);
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
  if (!email || password.length < 6) return toast('กรอกอีเมลและรหัสผ่านอย่างน้อย 6 ตัว', true);
  const {error} = await sb.auth.signUp({email, password});
  if (error) return toast(errMsg(error), true);
  toast('สร้างบัญชีแล้ว กรุณาตรวจอีเมลยืนยันตามการตั้งค่า Supabase');
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
    loginView.classList.add('hidden');
    appView.classList.remove('hidden');
    $('#userBadge').textContent = `${profile.display_name} · ${profile.role === 'admin' ? 'ผู้ดูแลระบบ' : 'เจ้าหน้าที่'}`;
    $$('.admin-only').forEach(el => el.classList.toggle('hidden', profile.role !== 'admin'));
    document.body.classList.toggle('is-admin', profile.role === 'admin');
    await runAutoExpiry(true);
    const hashRoute = location.hash.replace(/^#/, '');
    const initialRoute = ['home','stock','move','weekly','activity','help','admin'].includes(hashRoute) ? hashRoute : 'home';
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
  stockCache = [];
  materialsCache = [];
  autoExpiryRan = false;
  showLogin();
}

function globalClick(e) {
  const r = e.target.closest('[data-route]');
  if (r) {
    e.preventDefault();
    navigate(r.dataset.route, {tab:r.dataset.moveTab});
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
    if (l) openIssueModal(l);
    return;
  }
  const scan = e.target.closest('[data-camera-scan]');
  if (scan) {
    e.preventDefault();
    startCameraScanner();
    return;
  }
  const c = e.target.closest('[data-check]');
  if (c) {
    openCheck(c.dataset.check);
    return;
  }
  const edit = e.target.closest('[data-edit-material]');
  if (edit) openMaterialEditor(edit.dataset.editMaterial);
}

function navActive() {
  $$('.bottom-nav button, .side-nav button').forEach(b => {
    const sameRoute = b.dataset.route === route;
    const active = sameRoute && (route !== 'move' ? true : ((b.dataset.moveTab || '') === moveTab || !b.dataset.moveTab));
    b.classList.toggle('active', active);
  });
}

async function navigate(r, options = {}) {
  route = r;
  if (r === 'move') moveTab = options.tab || moveTab || 'receive';
  navActive();
  loading();
  try {
    if (r === 'home') await renderHome();
    else if (r === 'stock') await renderStock();
    else if (r === 'move') await renderMove(moveTab);
    else if (r === 'weekly') await renderWeekly();
    else if (r === 'activity') await renderActivity();
    else if (r === 'help') renderHelp();
    else if (r === 'admin') await renderAdmin();
    else await renderHome();
    try { history.replaceState({}, '', `${location.pathname}${location.search}#${r}`); } catch (_) {}
    window.scrollTo({top:0, behavior:'smooth'});
  } catch (e) {
    page.innerHTML = `<div class="card notice">${esc(errMsg(e))}</div>`;
  }
}

async function runAutoExpiry(showNotice = false) {
  if (!sb || autoExpiryRan) return 0;
  autoExpiryRan = true;
  const {data, error} = await sb.rpc('fn_auto_expire_stock');
  if (error) {
    console.warn('fn_auto_expire_stock:', error.message);
    return 0;
  }
  const count = Number(Array.isArray(data) ? data[0] : data) || 0;
  if (count > 0) {
    stockCache = [];
    if (showNotice) toast(`ระบบนำ Lot หมดอายุออกจากสต๊อกอัตโนมัติแล้ว ${count} Lot`);
  }
  return count;
}

async function getLots(force = false) {
  await runAutoExpiry(false);
  if (!force && stockCache.length) return stockCache;
  const {data, error} = await sb.from('v_lot_balances').select('*').eq('active', true).order('material_code').order('lot_no');
  if (error) throw error;
  stockCache = (data || []).filter(x => Number(x.balance) !== 0 && !isExpired(x));
  return stockCache;
}

async function ensureCheck() {
  await runAutoExpiry(false);
  const {data, error} = await sb.rpc('fn_ensure_weekly_check');
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

function statusBadge(x) {
  if (Number(x.balance) < 0) return '<span class=\"badge danger\">ยอดติดลบ</span>';
  if (Number(x.balance) <= Number(x.min_qty)) return '<span class=\"badge warn\">ต่ำกว่าขั้นต่ำ</span>';
  if (x.days_to_expiry !== null && Number(x.days_to_expiry) <= 90) return '<span class=\"badge warn\">ใกล้หมดอายุ</span>';
  return '<span class=\"badge ok\">พร้อมใช้</span>';
}

function todayIso() {
  const x = new Date();
  x.setHours(0,0,0,0);
  return x.toISOString();
}

function ownerOptions(staff = [], selected = '') {
  return [`<option value=\"\">ยังไม่กำหนด</option>`].concat((staff || []).map(s => `<option value=\"${esc(s.email)}\" ${s.email === selected ? 'selected' : ''}>${esc(s.display_name)}${s.role === 'admin' ? ' (Admin)' : ''}</option>`)).join('');
}

function groupByOwner(summaryRows = []) {
  const map = new Map();
  summaryRows.forEach(row => {
    const key = row.responsible_email || 'unassigned';
    if (!map.has(key)) map.set(key, {
      responsible_email: row.responsible_email || '',
      responsible_name: row.responsible_name || 'ยังไม่กำหนด',
      materials: 0,
      active_lots: 0,
      low_count: 0,
      out_count: 0
    });
    const item = map.get(key);
    item.materials += 1;
    item.active_lots += Number(row.active_lots || 0);
    if (Number(row.total_balance || 0) <= 0) item.out_count += 1;
    else if (Number(row.total_balance || 0) <= Number(row.min_qty || 0)) item.low_count += 1;
  });
  return [...map.values()].sort((a,b) => (b.out_count + b.low_count) - (a.out_count + a.low_count) || a.responsible_name.localeCompare(b.responsible_name, 'th'));
}

async function renderHome() {
  const [lots, summaryRes, checkRes, activityRes, expiredCountRes] = await Promise.all([
    getLots(true),
    sb.from('v_inventory_summary').select('*').order('material_code'),
    ensureCheck(),
    sb.from('v_audit_activity').select('*').limit(120),
    sb.from('audit_logs').select('id', {head:true, count:'exact'}).eq('action', 'AUTO_EXPIRED')
  ]);
  if (summaryRes.error) throw summaryRes.error;
  if (activityRes.error) throw activityRes.error;
  if (expiredCountRes.error) throw expiredCountRes.error;

  const summaries = summaryRes.data || [];
  const activities = activityRes.data || [];
  const startIso = todayIso();
  const todayActivities = activities.filter(x => x.created_at && new Date(x.created_at).toISOString() >= startIso);
  const outMaterials = summaries.filter(x => Number(x.total_balance || 0) <= 0);
  const lowMaterials = summaries.filter(x => Number(x.total_balance || 0) > 0 && Number(x.total_balance || 0) <= Number(x.min_qty || 0));
  const nearExpiry = lots.filter(x => Number(x.balance || 0) > 0 && x.days_to_expiry !== null && Number(x.days_to_expiry) >= 0 && Number(x.days_to_expiry) <= 30);
  const receiveToday = todayActivities.filter(x => x.action === 'RECEIVE').length;
  const issueToday = todayActivities.filter(x => x.action === 'ISSUE').length;
  const expiredRemoved = Number(expiredCountRes.count || 0);
  const ownerGroups = groupByOwner(summaries);

  let prog = null;
  if (checkRes) {
    const q = await sb.from('v_weekly_check_progress').select('*').eq('check_id', checkRes.id).maybeSingle();
    prog = q.data;
  }

  const productRows = [...summaries].sort((a, b) => {
    const aScore = Number(a.total_balance || 0) <= 0 ? 3 : (Number(a.total_balance || 0) <= Number(a.min_qty || 0) ? 2 : 0);
    const bScore = Number(b.total_balance || 0) <= 0 ? 3 : (Number(b.total_balance || 0) <= Number(b.min_qty || 0) ? 2 : 0);
    return bScore - aScore || Number(a.total_balance || 0) - Number(b.total_balance || 0);
  }).slice(0, 8);

  page.innerHTML = `
    <section class="hero-card">
      <div>
        <h2>สวัสดี ${esc(profile.display_name)}</h2>
        <p>ภาพรวมสต๊อกของวันนี้ ดูได้ทั้งตามสินค้า ตามผู้ดูแล และเข้าหน้านำเข้า/นำออกได้ทันที</p>
      </div>
      <div class="hero-icon">${icon('box')}</div>
    </section>

    <div class="grid kpi-grid kpi-grid-6">
      <div class="card kpi"><div class="kpi-top"><small>สินค้าหมด</small><span class="kpi-icon danger">${icon('box')}</span></div><strong>${outMaterials.length}</strong><small>รายการ</small></div>
      <div class="card kpi"><div class="kpi-top"><small>ต่ำกว่าขั้นต่ำ</small><span class="kpi-icon warn">${icon('alert')}</span></div><strong>${lowMaterials.length}</strong><small>รายการ</small></div>
      <div class="card kpi"><div class="kpi-top"><small>นำเข้า (วันนี้)</small><span class="kpi-icon">${icon('plus')}</span></div><strong>${receiveToday}</strong><small>รายการ</small></div>
      <div class="card kpi"><div class="kpi-top"><small>นำออก (วันนี้)</small><span class="kpi-icon info">${icon('minus')}</span></div><strong>${issueToday}</strong><small>รายการ</small></div>
      <div class="card kpi"><div class="kpi-top"><small>หมดอายุ (นำออกแล้ว)</small><span class="kpi-icon info">${icon('history')}</span></div><strong>${expiredRemoved}</strong><small>Lot</small></div>
      <div class="card kpi"><div class="kpi-top"><small>ใกล้หมดอายุ (≤ 30 วัน)</small><span class="kpi-icon warn">${icon('calendar')}</span></div><strong>${nearExpiry.length}</strong><small>Lot</small></div>
    </div>

    <div class="overview-grid">
      <section class="card table-card">
        <div class="section-title compact">
          <div><h3>ภาพรวมตามสินค้า</h3><p class="muted small">Top สินค้าที่ต้องเฝ้าระวัง</p></div>
          <div class="segmented"><button id="homeModeProduct" class="seg active" type="button">ดูตามสินค้า</button><button id="homeModeOwner" class="seg" type="button">ดูตามผู้ดูแล</button></div>
        </div>
        <div id="homeOverviewPane"></div>
      </section>

      <section class="card activity-panel">
        <div class="section-title compact"><div><h3>กิจกรรมล่าสุด</h3><p class="muted small">รายการล่าสุดในระบบ</p></div><button class="mini" data-route="activity">ดูทั้งหมด ${icon('arrow')}</button></div>
        <div class="activity-list">${activities.slice(0, 6).map(activityCard).join('') || '<div class="card empty">ยังไม่มีกิจกรรม</div>'}</div>
      </section>
    </div>

    <div class="grid quick-grid">
      <button class="quick" data-route="move" data-move-tab="receive"><span class="quick-icon">${icon('plus')}</span><span>นำเข้า</span><small>เพิ่ม Lot ใหม่ และพิมพ์ QR Sticker</small></button>
      <button class="quick" data-route="move" data-move-tab="issue"><span class="quick-icon">${icon('minus')}</span><span>นำออก</span><small>สแกน QR หรือเลือกรายการที่ต้องใช้</small></button>
      <button class="quick" data-route="stock"><span class="quick-icon">${icon('search')}</span><span>สต๊อกคงเหลือ</span><small>ค้นหา ดู Lot และดูตามผู้ดูแล</small></button>
      <button class="quick" data-route="weekly"><span class="quick-icon">${icon('check')}</span><span>ตรวจวันศุกร์</span><small>${prog ? `ความคืบหน้า ${prog.checked_items}/${prog.total_items}` : 'ตรวจสต๊อกประจำสัปดาห์'}</small></button>
    </div>

    ${prog ? `<div class="card"><div class="check-info"><div><strong>ตรวจสต๊อกวันศุกร์ ${d(prog.week_friday)}</strong><div class="muted small">${prog.status === 'COMPLETED' ? 'ปิดรอบแล้ว' : 'กำลังดำเนินการ'}</div></div><span class="badge ${prog.status === 'COMPLETED' ? 'ok' : 'info'}">${prog.checked_items}/${prog.total_items}</span></div><div class="progress" style="margin-top:13px"><span style="width:${prog.percent_complete}%"></span></div></div>` : ''}
  `;

  const productHtml = `
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>รายการสินค้า</th><th>คงเหลือ</th><th>ขั้นต่ำ</th><th>ผู้ดูแล</th><th>สถานะ</th></tr></thead>
      <tbody>${productRows.map(x => `<tr><td><strong>${esc(x.material_name)}</strong><div class="muted small">${esc(x.material_code)}</div></td><td>${qty(x.total_balance)}</td><td>${qty(x.min_qty)}</td><td>${esc(x.responsible_name || '-')}</td><td>${Number(x.total_balance || 0) <= 0 ? '<span class="badge danger">หมด</span>' : (Number(x.total_balance || 0) <= Number(x.min_qty || 0) ? '<span class="badge warn">ต่ำกว่าขั้นต่ำ</span>' : '<span class="badge ok">พร้อมใช้</span>')}</td></tr>`).join('') || '<tr><td colspan="5">ไม่มีข้อมูล</td></tr>'}</tbody>
    </table></div>`;
  const ownerHtml = `
    <div class="owner-summary-grid">${ownerGroups.map(g => `<div class="owner-box"><strong>${esc(g.responsible_name)}</strong><div class="muted small">${esc(g.responsible_email || 'ยังไม่กำหนด')}</div><div class="owner-stats"><span>ดูแล ${g.materials} รายการ</span><span>ต่ำกว่าขั้นต่ำ ${g.low_count}</span><span>หมด ${g.out_count}</span></div></div>`).join('') || '<div class="card empty">ไม่มีข้อมูลผู้ดูแล</div>'}</div>`;

  const pane = $('#homeOverviewPane');
  const setMode = mode => {
    $('#homeModeProduct').classList.toggle('active', mode === 'product');
    $('#homeModeOwner').classList.toggle('active', mode === 'owner');
    pane.innerHTML = mode === 'owner' ? ownerHtml : productHtml;
  };
  $('#homeModeProduct').onclick = () => setMode('product');
  $('#homeModeOwner').onclick = () => setMode('owner');
  setMode('product');
}

function lotCard(l) {
  return `
    <div class="card lot-card">
      <div class="lot-main">
        <div class="lot-code">${icon('qr')} ${esc(lotKey(l))}</div>
        <div class="lot-title">${esc(l.material_code)} · ${esc(l.material_name)}</div>
        <div class="lot-meta">Lot ${esc(l.lot_no)} · EXP ${d(l.expiry_date)}</div>
        <div class="lot-meta">ผู้ดูแล: ${esc(l.responsible_name || '-')}</div>
        <div style="margin-top:8px">${statusBadge(l)}</div>
        <div class="actions">
          <button class="mini" data-print="${esc(l.lot_id)}">${icon('print')} พิมพ์ QR</button>
          ${Number(l.balance) > 0 ? `<button class="mini ghost" data-issue-lot="${esc(l.lot_id)}">${icon('minus')} เบิกออก</button>` : ''}
        </div>
      </div>
      <div class="qty-wrap"><div class="qty">${qty(l.balance)}</div><div class="muted small">${esc(l.unit)}</div></div>
    </div>`;
}

async function renderStock() {
  const lots = await getLots(true);
  page.innerHTML = `
    <div class="page-head"><div><h2>สต๊อกตาม Lot</h2><p class="muted small">แสดงเฉพาะ Lot ที่ยังใช้งาน ไม่รวมของหมดอายุ</p></div><span class="badge info">${lots.length} Lot</span></div>
    <div class="toolbar">
      <div class="search-box">${icon('search')}<input id="stockSearch" placeholder="ค้นหารหัส ชื่อ Lot หรือ QR Code"></div>
      <button class="mini" id="stockSearchBtn">ค้นหา</button>
    </div>
    <div class="filters">
      <button class="chip active" data-filter="positive">คงเหลือ</button>
      <button class="chip" data-filter="all">ทั้งหมด</button>
      <button class="chip" data-filter="low">ต่ำกว่าขั้นต่ำ</button>
      <button class="chip" data-filter="expiry">ใกล้หมดอายุ</button>
      <button class="chip" data-filter="negative">ยอดติดลบ</button>
    </div>
    <div id="stockList" class="list"></div>`;

  let filter = 'positive';
  const draw = () => {
    const s = $('#stockSearch').value.trim().toLowerCase();
    let arr = lots.filter(x => !s || `${x.material_code} ${x.material_name} ${x.lot_no} ${lotKey(x)}`.toLowerCase().includes(s));
    if (filter === 'positive') arr = arr.filter(x => Number(x.balance) > 0);
    if (filter === 'low') arr = arr.filter(x => Number(x.balance) > 0 && Number(x.balance) <= Number(x.min_qty));
    if (filter === 'expiry') arr = arr.filter(x => x.days_to_expiry !== null && Number(x.days_to_expiry) <= 90 && Number(x.balance) > 0);
    if (filter === 'negative') arr = arr.filter(x => Number(x.balance) < 0);
    $('#stockList').innerHTML = arr.map(lotCard).join('') || `<div class="card empty">${icon('search')}<div>ไม่พบรายการ</div></div>`;
  };
  $('#stockSearch').addEventListener('input', draw);
  $('#stockSearchBtn').addEventListener('click', draw);
  $$('[data-filter]').forEach(b => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    $$('[data-filter]').forEach(x => x.classList.toggle('active', x === b));
    draw();
  }));
  draw();
}

async function printLabel(lotId) {
  // เปิดหน้าต่างทันทีจากการกดของผู้ใช้ เพื่อไม่ให้ Chrome/Safari บล็อก Pop-up
  const popup = window.open('about:blank', 'cnmi_inventory_label', 'width=430,height=360');
  if (!popup) return toast('เบราว์เซอร์บล็อกหน้าพิมพ์ กรุณาอนุญาต Pop-up ของเว็บไซต์นี้', true);
  popup.document.write('<!doctype html><meta charset="utf-8"><title>กำลังเตรียมสติ๊กเกอร์</title><body style="font-family:system-ui;padding:24px">กำลังเตรียม QR Sticker…</body>');
  popup.document.close();
  try {
    const l = stockCache.find(x => x.lot_id === lotId) || (await getLots(true)).find(x => x.lot_id === lotId);
    if (!l) {
      popup.close();
      return toast('ไม่พบ Lot', true);
    }
    const appBase = C.PUBLIC_URL || `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`;
    const issueUrl = new URL(appBase, location.href);
    issueUrl.searchParams.set('issue', lotKey(l));
    const params = new URLSearchParams({
      code:l.material_code,
      name:l.label_name || l.material_name,
      lot:l.lot_no,
      exp:l.expiry_date ? d(l.expiry_date) : 'ไม่ระบุ',
      key:lotKey(l),
      qr:issueUrl.toString(),
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

async function renderMove(defaultTab = 'receive') {
  const [mats, lots] = await Promise.all([loadMaterials(), getLots(true)]);
  page.innerHTML = `
    <div class="page-head"><div><h2>นำเข้า–นำออก</h2><p class="muted small">เลือกงานที่ต้องทำ ระบบจะบันทึกผู้ทำรายการและเวลาอัตโนมัติ</p></div></div>
    <div class="tabs"><button data-tab="receive">นำเข้า</button><button data-tab="issue">นำออก</button></div>
    <div id="movePane"></div>`;

  const draw = tab => {
    $$('[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
    if (tab === 'receive') {
      $('#movePane').innerHTML = `
        <form id="receiveForm" class="card form-card form-grid">
          <label>วัสดุ<select id="rMat" required><option value="">เลือกวัสดุ</option>${mats.map(m => `<option value="${esc(m.code)}">${esc(m.code)} · ${esc(m.name)}</option>`).join('')}</select></label>
          <div class="form-grid two"><label>Lot<input id="rLot" required autocomplete="off"></label><label>วันหมดอายุ<input id="rExp" type="date"></label></div>
          <label>จำนวน<input id="rQty" type="number" min="0.01" step="0.01" required inputmode="decimal"></label>
          <p class="field-hint">หลังบันทึกสามารถกดพิมพ์ QR Sticker และหน้าพิมพ์จะเด้งขึ้นทันที</p>
          <button class="primary" type="submit">${icon('plus')} บันทึกนำเข้า</button>
        </form>`;
      $('#receiveForm').addEventListener('submit', receive);
    } else {
      $('#movePane').innerHTML = `
        <div class="card scan-card">
          <div class="scan-icon">${icon('qr')}</div>
          <div><h3>สแกน QR Sticker</h3><p>สแกนด้วยกล้องมือถือ หรือพิมพ์รหัส เช่น BB020-69020</p></div>
          <button class="secondary scan-action" type="button" data-camera-scan>${icon('camera')} เปิดกล้องสแกน</button>
        </div>
        <form id="issueForm" class="card form-card form-grid" style="margin-top:12px">
          <label>รหัส QR / รหัสล็อต
            <div class="toolbar" style="margin:0"><input id="issueCode" autocomplete="off" placeholder="เช่น BB020-69020"><button type="button" class="mini" id="findIssueCode">ค้นหา</button></div>
          </label>
          <label>เลือก Lot<select id="iLot" required><option value="">เลือก Lot</option>${lots.filter(l => Number(l.balance) > 0).map(l => `<option value="${esc(l.lot_id)}">${esc(lotKey(l))} · ${esc(l.material_name)} · เหลือ ${qty(l.balance)} ${esc(l.unit)}</option>`).join('')}</select></label>
          <div id="selectedLot"></div>
          <label>จำนวน<input id="iQty" type="number" min="0.01" step="0.01" value="1" required inputmode="decimal"></label>
          <label>หมายเหตุ<textarea id="iReason" rows="2" placeholder="ระบุเมื่อต้องการ"></textarea></label>
          <button class="primary" type="submit">${icon('minus')} ยืนยันนำออก</button>
        </form>`;

      const select = $('#iLot');
      const showSelected = () => {
        const l = lots.find(x => x.lot_id === select.value);
        $('#selectedLot').innerHTML = l ? `<div class="selected-lot"><div><strong>${esc(l.material_code)} · ${esc(l.material_name)}</strong><small>${esc(lotKey(l))} · EXP ${d(l.expiry_date)}</small></div><span class="badge info">เหลือ ${qty(l.balance)} ${esc(l.unit)}</span></div>` : '';
      };
      select.addEventListener('change', showSelected);
      $('#findIssueCode').addEventListener('click', async () => {
        const l = findLotByCode($('#issueCode').value, lots);
        if (!l) return toast('ไม่พบ QR Code หรือรหัสล็อตนี้', true);
        select.value = l.lot_id;
        showSelected();
        $('#iQty').focus();
      });
      $('#issueCode').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); $('#findIssueCode').click(); }
      });
      $('#issueForm').addEventListener('submit', issue);
    }
  };

  $$('[data-tab]').forEach(b => b.addEventListener('click', () => draw(b.dataset.tab)));
  draw(defaultTab === 'issue' ? 'issue' : 'receive');
}

async function receive(e) {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  const p = {
    p_material_code:$('#rMat').value,
    p_lot_no:$('#rLot').value.trim(),
    p_expiry_date:$('#rExp').value || null,
    p_quantity:Number($('#rQty').value)
  };
  const {data, error} = await sb.rpc('fn_receive_stock', p);
  btn.disabled = false;
  if (error) return toast(errMsg(error), true);
  materialsCache = [];
  stockCache = [];
  toast('รับเข้าสต๊อกแล้ว');
  const row = Array.isArray(data) ? data[0] : data;
  openModal(`
    <h3>รับเข้าเรียบร้อย</h3>
    <p class="muted">ยอดใหม่ ${qty(row?.quantity_after)}</p>
    <div class="actions"><button class="primary" data-print="${esc(row?.lot_id || '')}">${icon('print')} พิมพ์ QR Sticker</button><button class="secondary modal-close">ปิด</button></div>`);
}

async function issue(e) {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  const {error} = await sb.rpc('fn_issue_stock', {
    p_lot_id:$('#iLot').value,
    p_quantity:Number($('#iQty').value),
    p_reason_detail:$('#iReason').value.trim() || null
  });
  btn.disabled = false;
  if (error) return toast(errMsg(error), true);
  stockCache = [];
  toast('บันทึกเบิกออกแล้ว');
  navigate('move', {tab:'issue'});
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
  const norm = value.toUpperCase().replace(/\s+/g, '');
  return lots.find(l => {
    const keys = [l.lot_id, lotKey(l), `${l.material_code}-${l.lot_no}`, `${l.material_code}|${l.lot_no}`];
    return keys.some(k => String(k || '').toUpperCase().replace(/\s+/g, '') === norm);
  }) || null;
}

async function resolveIssueCode(code) {
  const lots = await getLots(true);
  const l = findLotByCode(code, lots);
  if (!l) return toast('ไม่พบ Lot จาก QR Code นี้ หรือ Lot ถูกเบิกหมด/หมดอายุแล้ว', true);
  openIssueModal(l);
}

function openIssueModal(l) {
  if (!l || Number(l.balance) <= 0) return toast('Lot นี้ไม่มียอดคงเหลือ', true);
  openModal(`
    <h3>เบิกออกจาก QR Sticker</h3>
    <div class="selected-lot"><div><strong>${esc(l.material_code)} · ${esc(l.material_name)}</strong><small>${esc(lotKey(l))} · EXP ${d(l.expiry_date)}</small></div><span class="badge info">เหลือ ${qty(l.balance)} ${esc(l.unit)}</span></div>
    <form id="quickIssueForm" class="form-grid" style="margin-top:15px">
      <label>จำนวน<input id="quickIssueQty" type="number" min="0.01" max="${Number(l.balance)}" step="0.01" value="1" required inputmode="decimal"></label>
      <label>หมายเหตุ<textarea id="quickIssueReason" rows="2" placeholder="ระบุเมื่อต้องการ"></textarea></label>
      <button class="primary" type="submit">${icon('minus')} ยืนยันนำออก</button>
    </form>`);
  $('#quickIssueForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    const {error} = await sb.rpc('fn_issue_stock', {
      p_lot_id:l.lot_id,
      p_quantity:Number($('#quickIssueQty').value),
      p_reason_detail:$('#quickIssueReason').value.trim() || null
    });
    btn.disabled = false;
    if (error) return toast(errMsg(error), true);
    closeModal();
    stockCache = [];
    toast('บันทึกเบิกออกแล้ว');
    if (route === 'stock') renderStock();
    else if (route === 'home') renderHome();
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
  if (code) await resolveIssueCode(code);
}

async function startCameraScanner() {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    openModal(`
      <h3>สแกน QR บนมือถือ</h3>
      <p>เบราว์เซอร์นี้ยังไม่รองรับกล้องสแกนภายในแอพ ให้เปิดกล้องปกติของ iPhone หรือ Android แล้วสแกน QR Sticker ระบบจะเปิดหน้าเบิกออกให้อัตโนมัติ</p>
      <form id="manualScanForm" class="form-grid"><label>หรือพิมพ์รหัส QR<input id="manualScanCode" placeholder="เช่น BB020-69020" autocomplete="off"></label><button class="primary" type="submit">ค้นหา Lot</button></form>`);
    $('#manualScanForm').addEventListener('submit', e => {
      e.preventDefault();
      const code = $('#manualScanCode').value;
      closeModal();
      resolveIssueCode(code);
    });
    return;
  }

  openModal(`
    <h3>สแกน QR Sticker</h3>
    <div style="position:relative;border-radius:18px;overflow:hidden;background:#111;aspect-ratio:1/1"><video id="scanVideo" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover"></video><div style="position:absolute;inset:18%;border:3px solid #fff;border-radius:18px;box-shadow:0 0 0 999px rgba(0,0,0,.22)"></div></div>
    <p class="muted small">วาง QR ให้อยู่ในกรอบ ระบบจะค้นหา Lot ให้อัตโนมัติ</p>`);

  try {
    const detector = new BarcodeDetector({formats:['qr_code']});
    scannerStream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}}, audio:false});
    const video = $('#scanVideo');
    video.srcObject = scannerStream;
    await video.play();
    const scan = async () => {
      if (!scannerStream || $('#modal').classList.contains('hidden')) return;
      try {
        const codes = await detector.detect(video);
        if (codes?.[0]?.rawValue) {
          const value = codes[0].rawValue;
          stopScanner();
          closeModal();
          resolveIssueCode(value);
          return;
        }
      } catch (_) {}
      scannerTimer = setTimeout(scan, 280);
    };
    scan();
  } catch (e) {
    stopScanner();
    $('#modalBody').innerHTML = `<h3>เปิดกล้องไม่สำเร็จ</h3><p>${esc(errMsg(e))}</p><p class="muted small">ใช้กล้องปกติของโทรศัพท์สแกน QR Sticker หรือพิมพ์รหัสในหน้าเบิกออกได้</p>`;
  }
}

function stopScanner() {
  if (scannerTimer) clearTimeout(scannerTimer);
  scannerTimer = null;
  if (scannerStream) scannerStream.getTracks().forEach(t => t.stop());
  scannerStream = null;
}

async function renderWeekly() {
  const check = await ensureCheck();
  if (!check) {
    page.innerHTML = '<div class="card empty">ยังไม่มีรอบตรวจ</div>';
    return;
  }
  const [{data, error}, staffRes] = await Promise.all([
    sb.from('v_weekly_check_items').select('*').eq('check_id', check.id).order('material_code').order('lot_no'),
    sb.from('staff_directory').select('*').eq('active', true).order('display_name')
  ]);
  if (error) throw error;
  if (staffRes.error) throw staffRes.error;
  const items = data || [];
  const staffList = staffRes.data || [];
  const done = items.filter(x => x.checked_at).length;
  const pct = items.length ? Math.round(done * 100 / items.length) : 100;

  const ownerSet = new Map();
  items.forEach(i => {
    if (i.responsible_email && !ownerSet.has(i.responsible_email)) ownerSet.set(i.responsible_email, i.responsible_name || i.responsible_email);
  });
  const ownerOptions = ['<option value="mine">ของฉัน</option>', '<option value="all">ทุกคน</option>'].concat([...ownerSet.entries()].sort((a,b)=>String(a[1]).localeCompare(String(b[1]), 'th')).map(([email, name]) => `<option value="${esc(email)}">${esc(name)}</option>`)).join('');

  page.innerHTML = `
    <div class="page-head"><div><h2>ตรวจสต๊อกวันศุกร์</h2><p class="muted small">รอบวันที่ ${d(check.week_friday)}</p></div><span class="badge ${check.status === 'COMPLETED' ? 'ok' : 'info'}">${check.status === 'COMPLETED' ? 'เสร็จแล้ว' : `${done}/${items.length}`}</span></div>
    <div class="card"><div class="check-info"><div><strong>ความคืบหน้า ${pct}%</strong><div class="muted small">กรองดูตามเจ้าหน้าที่แต่ละคนได้</div></div></div><div class="progress" style="margin-top:13px"><span style="width:${pct}%"></span></div></div>
    <div class="weekly-tools">
      <label>กรองเจ้าหน้าที่<select id="weeklyOwnerFilter">${ownerOptions}</select></label>
      <div class="filters" style="margin-bottom:0"><button class="chip active" data-wf="pending">ยังไม่ตรวจ</button><button class="chip" data-wf="mine">งานของฉัน</button><button class="chip" data-wf="all">ทั้งหมด</button><button class="chip" data-wf="mismatch">เคยไม่ตรง</button></div>
    </div>
    <div id="checkList" class="list"></div>
    ${check.status !== 'COMPLETED' ? '<button id="completeCheck" class="primary" style="width:100%;margin-top:15px">เสร็จสิ้นการตรวจสต๊อก</button>' : ''}`;

  let f = 'pending';
  const ownerFilter = $('#weeklyOwnerFilter');
  ownerFilter.value = profile.role === 'admin' ? 'all' : 'mine';

  const draw = () => {
    let arr = items;
    const owner = ownerFilter.value;
    if (owner === 'mine') arr = arr.filter(x => x.responsible_email === profile.email || x.checked_by_email === profile.email || profile.role === 'admin');
    else if (owner !== 'all') arr = arr.filter(x => x.responsible_email === owner);
    if (f === 'mine') arr = arr.filter(x => x.responsible_email === profile.email || x.checked_by_email === profile.email || profile.role === 'admin');
    if (f === 'pending') arr = arr.filter(x => !x.checked_at);
    if (f === 'mismatch') arr = arr.filter(x => x.result === 'ADJUSTED');
    $('#checkList').innerHTML = arr.map(x => `
      <div class="card check-card ${x.checked_at ? (x.result === 'ADJUSTED' ? 'mismatch' : 'checked') : ''}">
        <div class="check-info"><div><strong>${esc(x.material_code)} · ${esc(x.material_name)}</strong><div class="lot-meta">${esc(lotKey(x))} · ระบบ ${qty(x.current_balance)} ${esc(x.unit)}</div><div class="lot-meta">ผู้ดูแล: ${esc(x.responsible_name || '-')}</div>${x.checked_at ? `<div class="lot-meta">ตรวจโดย ${esc(x.checked_by_name || x.checked_by_email)} · ${dt(x.checked_at)}</div>` : ''}</div>${x.checked_at ? `<span class="badge ${x.result === 'MATCHED' ? 'ok' : 'warn'}">${x.result === 'MATCHED' ? 'ตรง' : 'ปรับแล้ว'}</span>` : `<button class="mini" data-check="${esc(x.item_id)}">ตรวจ</button>`}</div>
      </div>`).join('') || '<div class="card empty">ไม่มีรายการตามตัวกรองนี้</div>';
  };
  ownerFilter.addEventListener('change', draw);
  $$('[data-wf]').forEach(b => b.addEventListener('click', () => {
    f = b.dataset.wf;
    $$('[data-wf]').forEach(x => x.classList.toggle('active', x === b));
    draw();
  }));
  draw();
  if ($('#completeCheck')) $('#completeCheck').onclick = async () => {
    const {error} = await sb.rpc('fn_complete_weekly_check', {p_check_id:check.id});
    if (error) return toast(errMsg(error), true);
    toast('ปิดรอบตรวจสต๊อกแล้ว');
    renderWeekly();
  };
  window._weeklyItems = items;
}

function openCheck(id) {
  const x = (window._weeklyItems || []).find(i => i.item_id === id);
  if (!x) return;
  const can = x.responsible_email === profile.email || profile.role === 'admin';
  if (!can) return toast('รายการนี้เป็นความรับผิดชอบของ ' + (x.responsible_name || x.responsible_email), true);
  openModal(`
    <h3>${esc(x.material_code)} · ${esc(x.material_name)}</h3>
    <p class="muted">${esc(lotKey(x))} · ยอดปัจจุบัน ${qty(x.current_balance)} ${esc(x.unit)}</p>
    <form id="checkForm" class="form-grid">
      <label>จำนวนที่พบจริง<input id="actualQty" type="number" min="0" step="0.01" value="${Number(x.current_balance)}" required inputmode="decimal"></label>
      <div id="reasonFields" class="form-grid hidden">
        <label>เหตุผล<select id="reasonCode"><option value="">เลือกเหตุผล</option><option>เบิกใช้แล้วไม่ได้บันทึก</option><option>รับเข้าหรือเบิกผิดจำนวน</option><option>สูญหายหรือหาไม่พบ</option><option>ชำรุด</option><option>นับครั้งก่อนผิด</option><option>Lot หรือสติ๊กเกอร์ไม่ตรง</option><option>อื่น ๆ</option></select></label>
        <label>รายละเอียด<textarea id="reasonDetail" rows="3"></textarea></label>
      </div>
      <button class="primary" type="submit">บันทึกผลตรวจ</button>
    </form>`);
  const toggle = () => $('#reasonFields').classList.toggle('hidden', Number($('#actualQty').value) === Number(x.current_balance));
  $('#actualQty').addEventListener('input', toggle);
  $('#checkForm').addEventListener('submit', async e => {
    e.preventDefault();
    const actual = Number($('#actualQty').value);
    const diff = actual !== Number(x.current_balance);
    if (diff && !$('#reasonCode').value) return toast('กรุณาเลือกเหตุผล', true);
    const {error} = await sb.rpc('fn_save_stock_check', {
      p_item_id:id,
      p_actual_qty:actual,
      p_reason_code:diff ? $('#reasonCode').value : null,
      p_reason_detail:diff ? $('#reasonDetail').value.trim() || null : null
    });
    if (error) return toast(errMsg(error), true);
    closeModal();
    stockCache = [];
    toast('บันทึกผลตรวจแล้ว');
    renderWeekly();
  });
}

function activityCard(a) {
  const detail = a.summary || {};
  return `<div class="card activity"><strong>${esc(a.action_label || a.action)}</strong><div>${esc(a.actor_name || a.actor_email || 'SYSTEM')}</div><div class="muted small">${esc(detail.material_code || detail.stock_code || '')} ${detail.lot_no ? '· Lot ' + esc(detail.lot_no) : ''} ${detail.before !== undefined ? '· ' + qty(detail.before) + ' → ' + qty(detail.after) : ''}</div><time>${dt(a.created_at)}</time></div>`;
}

async function renderActivity() {
  const {data, error} = await sb.from('v_audit_activity').select('*').limit(200);
  if (error) throw error;
  page.innerHTML = `
    <div class="page-head"><div><h2>ประวัติการทำรายการ</h2><p class="muted small">รวมรับเข้า เบิกออก ปรับยอด พิมพ์ และนำของหมดอายุออก</p></div></div>
    <div class="toolbar"><div class="search-box">${icon('search')}<input id="activitySearch" placeholder="ค้นหาชื่อ รหัส Lot หรือเหตุผล"></div><button class="mini" id="activitySearchBtn">ค้นหา</button></div>
    <div id="activityList" class="list"></div>`;
  const draw = () => {
    const s = $('#activitySearch').value.toLowerCase();
    const arr = (data || []).filter(a => !s || JSON.stringify(a).toLowerCase().includes(s));
    $('#activityList').innerHTML = arr.map(activityCard).join('') || '<div class="card empty">ไม่พบกิจกรรม</div>';
  };
  $('#activitySearch').addEventListener('input', draw);
  $('#activitySearchBtn').addEventListener('click', draw);
  draw();
}

async function renderAdmin() {
  if (profile.role !== 'admin') {
    page.innerHTML = '<div class="card notice">เฉพาะผู้ดูแลระบบ</div>';
    return;
  }
  const [{data:m, error:me}, {data:s, error:se}] = await Promise.all([
    sb.from('materials').select('*').eq('is_main', true).order('code'),
    sb.from('staff_directory').select('*').order('display_name')
  ]);
  if (me || se) throw me || se;
  materialsCache = [];
  window._adminMaterials = m;
  window._adminStaff = s;
  page.innerHTML = `
    <div class="page-head"><div><h2>ตั้งค่าระบบ</h2><p class="muted small">แอดมินสามารถเปลี่ยนสิทธิ์และเปลี่ยนผู้ดูแลสินค้าได้ตลอด</p></div></div>
    <div class="section-title"><h3>ผู้ใช้งาน</h3></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>ชื่อ</th><th>อีเมล</th><th>สิทธิ์</th></tr></thead><tbody>${s.map(x => `<tr><td>${esc(x.display_name)}</td><td>${esc(x.email)}</td><td><select data-role-email="${esc(x.email)}"><option value="staff" ${x.role === 'staff' ? 'selected' : ''}>เจ้าหน้าที่</option><option value="admin" ${x.role === 'admin' ? 'selected' : ''}>ผู้ดูแลระบบ</option></select></td></tr>`).join('')}</tbody></table></div>

    <div class="section-title"><h3>กำหนดผู้ดูแลวัสดุหลัก</h3></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>รหัส</th><th>ชื่อวัสดุ</th><th>ขั้นต่ำ</th><th>ผู้ดูแล</th><th>จัดการ</th></tr></thead><tbody>${m.map(x => `<tr><td>${esc(x.code)}</td><td><strong>${esc(x.name)}</strong><div class="muted small">ชื่อบนสติ๊กเกอร์: ${esc(x.label_name || x.name)}</div></td><td>${qty(x.min_qty)} ${esc(x.unit)}</td><td><select data-owner-code="${esc(x.code)}">${ownerOptions(s, x.responsible_email || '')}</select></td><td><button class="mini" data-edit-material="${esc(x.code)}">แก้ไข</button></td></tr>`).join('')}</tbody></table></div>`;

  $$('[data-role-email]').forEach(sel => sel.addEventListener('change', async () => {
    const {error} = await sb.from('staff_directory').update({role:sel.value}).eq('email', sel.dataset.roleEmail);
    if (error) return toast(errMsg(error), true);
    toast('บันทึกสิทธิ์แล้ว');
  }));

  $$('[data-owner-code]').forEach(sel => sel.addEventListener('change', async () => {
    const {error} = await sb.from('materials').update({responsible_email: sel.value || null}).eq('code', sel.dataset.ownerCode);
    if (error) return toast(errMsg(error), true);
    stockCache = [];
    materialsCache = [];
    toast('เปลี่ยนผู้ดูแลแล้ว');
  }));
}

function openMaterialEditor(code) {
  const x = (window._adminMaterials || []).find(m => m.code === code);
  const staff = window._adminStaff || [];
  if (!x) return;
  openModal(`
    <h3>${esc(x.code)} · ${esc(x.name)}</h3>
    <form id="matForm" class="form-grid">
      <label>ชื่อบนสติ๊กเกอร์<input id="matLabel" maxlength="60" value="${esc(x.label_name || x.name)}"></label>
      <label>จำนวนขั้นต่ำ<input id="matMin" type="number" min="0" step="0.01" value="${Number(x.min_qty || 0)}"></label>
      <label>ผู้รับผิดชอบ<select id="matOwner">${ownerOptions(staff, x.responsible_email || '')}</select></label>
      <button class="primary" type="submit">บันทึก</button>
    </form>`);
  $('#matForm').addEventListener('submit', async e => {
    e.preventDefault();
    const {error} = await sb.from('materials').update({
      label_name:$('#matLabel').value.trim(),
      min_qty:Number($('#matMin').value),
      responsible_email:$('#matOwner').value || null
    }).eq('code', code);
    if (error) return toast(errMsg(error), true);
    closeModal();
    stockCache = [];
    materialsCache = [];
    toast('บันทึกวัสดุแล้ว');
    renderAdmin();
  });
}

function renderHelp() {
  page.innerHTML = `
    <div class="page-head"><div><h2>คู่มือย่อ</h2><p class="muted small">ขั้นตอนหลักสำหรับเจ้าหน้าที่</p></div></div>
    <div class="grid">
      <div class="card help-card"><h3>รับเข้าและพิมพ์ QR</h3><ol class="help-steps"><li>เปิดเมนู รับ–เบิก → รับเข้า</li><li>เลือกวัสดุ ใส่ Lot วันหมดอายุ และจำนวน</li><li>กดบันทึก แล้วกด พิมพ์ QR Sticker</li><li>หน้าพิมพ์จะเปิดทันที ไม่ต้องกดปุ่มพิมพ์ซ้ำ</li></ol></div>
      <div class="card help-card"><h3>เบิกออกด้วย QR</h3><ol class="help-steps"><li>ใช้กล้อง iPhone/Android สแกน QR บนสติ๊กเกอร์</li><li>ระบบเปิดรายการ Lot ที่ตรงกัน</li><li>ใส่จำนวนและยืนยันเบิกออก</li></ol><p class="muted small">QR ใช้รหัสล็อตแบบเดิม เช่น BB020-69020 และแนบลิงก์เปิดแอพโดยตรง ไม่ใช้ UUID ที่อ่านไม่รู้เรื่อง</p></div>
      <div class="card help-card"><h3>ของหมดอายุ</h3><p>เมื่อเปิดแอพ ระบบจะทำรายการ EXPIRED นำยอดคงเหลือเป็นศูนย์ ปิด Lot และเก็บประวัติให้อัตโนมัติ เจ้าหน้าที่ไม่ต้องเบิกออกเอง</p></div>
      <div class="card help-card"><h3>ตรวจทุกวันศุกร์</h3><ol class="help-steps"><li>เปิดเมนู ตรวจศุกร์</li><li>เลือก งานของฉัน</li><li>นับจริงทีละ Lot</li><li>หากไม่ตรงต้องเลือกเหตุผล ระบบปรับยอดและเก็บ Log</li></ol></div>
      <div class="card help-card"><h3>ตั้งเครื่องพิมพ์ Godex</h3><p>Paper 25 × 20 mm · Scale 100% · Margin None · ปิด Header/Footer</p></div>
      <div class="card help-card"><h3>ติดตั้งบนมือถือ</h3><p><strong>Android:</strong> เปิด Chrome → เมนู → ติดตั้งแอป<br><strong>iPhone:</strong> เปิด Safari → แชร์ → เพิ่มไปยังหน้าจอโฮม</p></div>
    </div>`;
}

init();
})();
