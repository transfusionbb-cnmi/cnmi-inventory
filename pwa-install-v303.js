/* CNMI Staff Planner PWA registration + install prompt — V303 */
(() => {
  'use strict';

  const scriptBaseUrl = document.currentScript
    ? new URL('.', document.currentScript.src)
    : new URL('./', window.location.href);

  let deferredInstallPrompt = null;
  let registrationReady = false;
  const installButtons = new Set();

  const isStandalone = () => (
    window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || window.navigator.standalone === true
  );
  const isAndroid = () => /Android/i.test(navigator.userAgent || '');
  const isIOS = () => /iPad|iPhone|iPod/i.test(navigator.userAgent || '')
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function pruneButtons() {
    installButtons.forEach((button) => {
      if (!button.isConnected) installButtons.delete(button);
    });
  }

  function setButtonsVisible(visible) {
    pruneButtons();
    installButtons.forEach((button) => {
      button.classList.toggle('hidden', !visible);
      button.disabled = false;
      button.setAttribute('aria-hidden', visible ? 'false' : 'true');
    });
  }

  function setButtonsBusy(busy, label) {
    pruneButtons();
    installButtons.forEach((button) => {
      button.disabled = busy;
      const labelNode = button.querySelector('[data-pwa-label]');
      if (label && labelNode) labelNode.textContent = label;
    });
  }

  function createButton(extraClass = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `pwa-install-btn ${extraClass}`.trim();
    button.innerHTML = '<span aria-hidden="true">⬇️</span><span data-pwa-label>ติดตั้งแอป</span>';
    button.addEventListener('click', handleInstallClick);
    installButtons.add(button);
    return button;
  }

  function ensureAuthButton() {
    const authCard = document.querySelector('.auth-card');
    if (!authCard || authCard.querySelector('[data-cnmi-pwa-auth-install="v303"]')) return;
    const wrapper = document.createElement('div');
    wrapper.dataset.cnmiPwaAuthInstall = 'v303';
    wrapper.className = 'pwa-install-auth-wrap';
    const button = createButton('pwa-install-btn--auth');
    const note = document.createElement('p');
    note.className = 'pwa-install-note';
    note.textContent = 'ติดตั้งแล้วเปิดเต็มหน้าจอเหมือนแอป';
    wrapper.append(button, note);
    const loginForm = authCard.querySelector('#loginForm, form.auth-panel');
    if (loginForm) authCard.insertBefore(wrapper, loginForm);
    else authCard.appendChild(wrapper);
  }

  function ensureMenuButton() {
    const sidebarFoot = document.querySelector('.sidebar-foot');
    if (!sidebarFoot || sidebarFoot.querySelector('[data-cnmi-pwa-menu-install="v303"]')) return;
    const button = createButton('pwa-install-btn--menu');
    button.dataset.cnmiPwaMenuInstall = 'v303';
    sidebarFoot.insertBefore(button, sidebarFoot.firstChild);
  }

  function ensureInstallUI() {
    createModal();
    ensureAuthButton();
    ensureMenuButton();
    setButtonsVisible(!isStandalone());
  }

  function createModal() {
    if (document.getElementById('pwaInstallModalV303')) return;
    const modal = document.createElement('div');
    modal.id = 'pwaInstallModalV303';
    modal.className = 'pwa-install-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'pwaInstallTitleV303');
    modal.innerHTML = `
      <div class="pwa-install-dialog">
        <button type="button" class="pwa-install-close" aria-label="ปิด">×</button>
        <h3 id="pwaInstallTitleV303">ติดตั้ง CNMI Staff Planner</h3>
        <div data-pwa-instructions></div>
      </div>`;
    modal.querySelector('.pwa-install-close').addEventListener('click', closeModal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal();
    });
    document.body.appendChild(modal);
  }

  function showModal(html) {
    createModal();
    const modal = document.getElementById('pwaInstallModalV303');
    if (!modal) return;
    modal.querySelector('[data-pwa-instructions]').innerHTML = html;
    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
  }

  function closeModal() {
    const modal = document.getElementById('pwaInstallModalV303');
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.classList.remove('modal-open');
  }

  async function handleInstallClick() {
    if (isStandalone()) {
      setButtonsVisible(false);
      return;
    }

    if (deferredInstallPrompt) {
      setButtonsBusy(true, 'กำลังเปิดหน้าติดตั้ง…');
      try {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        if (choice?.outcome === 'accepted') setButtonsBusy(true, 'กำลังติดตั้ง…');
        else setButtonsBusy(false, 'ติดตั้งแอป');
      } catch (error) {
        console.warn('[PWA V303] Install prompt failed:', error);
        setButtonsBusy(false, 'ติดตั้งแอป');
        showManualInstructions();
      }
      return;
    }

    if (!registrationReady && 'serviceWorker' in navigator) {
      setButtonsBusy(true, 'กำลังเตรียมแอป…');
      try {
        await navigator.serviceWorker.ready;
        registrationReady = true;
      } catch (_) {}
      setButtonsBusy(false, 'ติดตั้งแอป');
    }
    showManualInstructions();
  }

  function showManualInstructions() {
    if (isAndroid()) {
      showModal(`
        <p>หากหน้าต่างติดตั้งไม่เด้ง ให้ทำตามนี้:</p>
        <ol>
          <li>เปิดด้วย <strong>Google Chrome</strong></li>
          <li>แตะเมนู <strong>⋮</strong></li>
          <li>เลือก <strong>ติดตั้งแอป</strong> หรือ <strong>เพิ่มไปยังหน้าจอหลัก</strong></li>
          <li>แตะ <strong>ติดตั้ง</strong></li>
        </ol>`);
      return;
    }
    if (isIOS()) {
      showModal(`
        <p>บน iPhone/iPad ให้เปิดด้วย Safari:</p>
        <ol>
          <li>แตะปุ่ม <strong>แชร์</strong></li>
          <li>เลือก <strong>เพิ่มไปยังหน้าจอโฮม</strong></li>
          <li>แตะ <strong>เพิ่ม</strong></li>
        </ol>`);
      return;
    }
    showModal('<p>เปิดเมนู Browser แล้วเลือก <strong>ติดตั้งแอป</strong> หรือกดไอคอนติดตั้งที่แถบที่อยู่</p>');
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const workerUrl = new URL('sw.js?v=428', scriptBaseUrl);
      const registration = await navigator.serviceWorker.register(workerUrl.href, { scope: scriptBaseUrl.pathname });
      registrationReady = true;
      registration.update().catch(() => {});
      console.info('[PWA V321] Service Worker registered:', registration.scope);
    } catch (error) {
      console.warn('[PWA V321] Service Worker registration failed:', error);
    }
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    ensureInstallUI();
    setButtonsVisible(!isStandalone());
    setButtonsBusy(false, 'ติดตั้งแอป');
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    setButtonsVisible(false);
    closeModal();
  });

  window.matchMedia('(display-mode: standalone)').addEventListener?.('change', (event) => {
    if (event.matches) setButtonsVisible(false);
  });

  document.addEventListener('DOMContentLoaded', () => {
    ensureInstallUI();
    registerServiceWorker();
    const observer = new MutationObserver(() => ensureInstallUI());
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
