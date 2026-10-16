// The Mini App. Talks to tgcloud/endpoints/* through Telegram.WebApp.Serverless,
// which sends the init data the platform verifies; no fetch of its own.
(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;
  const inTelegram = Boolean(tg && tg.initData);
  const $ = (id) => document.getElementById(id);

  const QUALITY_LABEL = { max: 'Макс' };
  const KIND_ICON = { video: '🎬', audio: '🎵', photo: '🖼️', animation: '🎞️', document: '📄' };
  const STATUS = {
    sent: ['Отправлено', 'ok'],
    worker: ['На сервере', ''],
    link: ['Ссылка', ''],
    started: ['В работе', ''],
    too_large: ['Большой файл', 'bad'],
    error: ['Ошибка', 'bad'],
  };

  const state = {
    tab: 'download',
    mode: 'v',
    quality: '1080',
    prefs: null,
    options: {
      qualities: ['360', '480', '720', '1080', '1440', '2160', 'max'],
      audioFormats: ['best', 'mp3', 'ogg', 'wav', 'opus'],
      audioBitrates: ['320', '256', '128', '96', '64'],
      codecs: ['h264', 'av1', 'vp9'],
    },
    features: null,
    subscription: null,
    token: null, // token of the link in the input, when it came from the chat
    tokenUrl: null,
    result: null,
    busy: false,
  };

  // ── helpers ────────────────────────────────────────────────────────────

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function supports(version) {
    return Boolean(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(version));
  }

  function haptic(kind) {
    const hf = tg && tg.HapticFeedback;
    if (!hf || !supports('6.1')) return;
    if (kind === 'select') hf.selectionChanged();
    else if (kind === 'light') hf.impactOccurred('light');
    else hf.notificationOccurred(kind); // success | error | warning
  }

  let toastTimer;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  /** Endpoint call as a promise; rejects with the platform's error object. */
  function call(name, input) {
    return new Promise((resolve, reject) => {
      if (!tg || !tg.Serverless) {
        const err = new Error('Откройте приложение в Telegram');
        err.type = 'NO_TELEGRAM';
        reject(err);
        return;
      }
      tg.Serverless.call(name, input || {}, (err, result) => (err ? reject(err) : resolve(result)));
    });
  }

  function errorCode(err) {
    return (err && err.type === 'ENDPOINT_ERROR' && err.parameters && err.parameters.code) || (err && err.type) || '';
  }

  function errorText(err) {
    if (err && err.type === 'ENDPOINT_ERROR' && err.message) return err.message;
    if (err && err.type === 'UNAUTHORIZED') return 'Сессия устарела — закройте и откройте приложение заново';
    if (err && err.status === 0) return 'Нет связи. Проверьте интернет и попробуйте ещё раз';
    return 'Что-то пошло не так. Попробуйте ещё раз';
  }

  function qualityLabel(q) {
    return QUALITY_LABEL[q] || `${q}p`;
  }

  function formatDate(unix) {
    const d = new Date(unix * 1000);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  // ── theme and Telegram chrome ──────────────────────────────────────────

  function applyChrome() {
    if (!tg) return;
    if (supports('6.1')) {
      tg.setHeaderColor('secondary_bg_color');
      tg.setBackgroundColor('secondary_bg_color');
    }
    if (supports('7.10')) tg.setBottomBarColor('secondary_bg_color');
  }

  const main = {
    available: false,
    init() {
      this.available = Boolean(inTelegram && tg.MainButton);
      if (!this.available) return;
      document.body.classList.add('has-main-button');
      tg.MainButton.setText('Получить');
      tg.MainButton.onClick(() => {
        haptic('light');
        resolveLink();
      });
    },
    sync() {
      if (!this.available) return;
      const show = state.tab === 'download' && $('gate').hidden && $('url').value.trim() !== '';
      if (show) tg.MainButton.show();
      else tg.MainButton.hide();
    },
    busy(on) {
      if (!this.available) return;
      if (on) {
        tg.MainButton.showProgress(false);
        tg.MainButton.disable();
      } else {
        tg.MainButton.hideProgress();
        tg.MainButton.enable();
      }
    },
  };

  // ── download tab ───────────────────────────────────────────────────────

  function renderQuality() {
    const box = $('quality');
    box.replaceChildren(
      ...state.options.qualities.map((q) =>
        h('button', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(q === state.quality),
          text: qualityLabel(q),
          onclick: () => {
            state.quality = q;
            haptic('select');
            renderQuality();
          },
        }),
      ),
    );
    $('quality-block').hidden = state.mode === 'a';
  }

  function setMode(mode) {
    state.mode = mode;
    for (const b of document.querySelectorAll('.segmented button')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
    renderQuality();
  }

  function syncInput() {
    const value = $('url').value.trim();
    $('clear').hidden = !value;
    if (state.token && value !== state.tokenUrl) state.token = null;
    main.sync();
  }

  function setBusy(on) {
    state.busy = on;
    $('go').disabled = on;
    $('go').textContent = on ? 'Ищу…' : 'Получить';
    main.busy(on);
    for (const b of document.querySelectorAll('#result .btn')) b.disabled = on;
  }

  function renderLoading() {
    $('result').replaceChildren(
      h('div', { class: 'card' }, h('div', { class: 'skeleton', style: 'width: 60%' }), h('div', { class: 'skeleton', style: 'width: 35%' })),
    );
  }

  function renderError(text) {
    $('result').replaceChildren(h('div', { class: 'card error-card', role: 'alert' }, text));
  }

  function resultHead(icon, title, sub) {
    return h(
      'div',
      { class: 'result-head' },
      h('div', { class: 'result-icon', 'aria-hidden': 'true' }, icon),
      h('div', null, h('div', { class: 'result-title' }, title), sub ? h('div', { class: 'result-sub' }, sub) : null),
    );
  }

  function describe(r) {
    const what = r.mode === 'a' ? 'звук' : qualityLabel(r.quality);
    return [r.host, what].filter(Boolean).join(' · ');
  }

  function sendButton(label, primary) {
    return h('button', { class: `btn${primary ? ' primary' : ''}`, onclick: sendToChat }, label);
  }

  function renderResult(r) {
    const card = h('div', { class: 'card' });
    if (r.status === 'file') {
      const limit = state.features ? state.features.uploadLimitMb : 50;
      card.append(
        resultHead(KIND_ICON[r.file.kind] || '📄', r.file.filename, describe(r)),
        h(
          'div',
          { class: 'stack' },
          h('button', { class: 'btn primary', onclick: () => download(r.file.url, r.file.filename) }, '⬇️ Скачать на устройство'),
          sendButton('📨 Отправить в чат', false),
        ),
        h('p', { class: 'hint' }, `В чат уходят файлы до ${limit} МБ, на устройство — любого размера. Ссылка живёт недолго.`),
      );
    } else if (r.status === 'worker') {
      card.append(
        resultHead('🎬', r.host || 'Видео', describe(r)),
        h('p', { class: 'result-sub' }, 'Это видео качает сервер бота: файл придёт в чат с ботом.'),
        h('div', { class: 'stack' }, sendButton('📨 Отправить в чат', true)),
      );
    } else if (r.status === 'picker') {
      const tiles = r.items.map((item) =>
        h(
          'button',
          {
            class: 'tile',
            type: 'button',
            'aria-label': `Скачать ${item.filename}`,
            onclick: () => download(item.url, item.filename),
          },
          item.thumb || item.type === 'photo'
            ? h('img', { src: item.thumb || item.url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
            : h('div', { class: 'placeholder' }, KIND_ICON[item.type === 'gif' ? 'animation' : item.type] || '📄'),
          h('span', { class: 'badge' }, item.type === 'video' ? 'видео' : item.type === 'gif' ? 'gif' : 'фото'),
        ),
      );
      card.append(
        resultHead('🗂️', `${r.items.length} файл(ов)`, r.host),
        h('div', { class: 'grid' }, tiles),
        h(
          'div',
          { class: 'stack' },
          r.audio ? h('button', { class: 'btn', onclick: () => download(r.audio.url, r.audio.filename) }, '🎵 Скачать звук') : null,
          sendButton('📨 Отправить всё в чат', true),
        ),
        h('p', { class: 'hint' }, 'Нажмите на файл, чтобы скачать его на устройство.'),
      );
    }
    $('result').replaceChildren(card);
  }

  async function resolveLink() {
    if (state.busy) return;
    const url = $('url').value.trim();
    if (!url) {
      toast('Вставьте ссылку');
      $('url').focus();
      return;
    }
    const input = { mode: state.mode, quality: state.quality };
    if (state.token && url === state.tokenUrl) input.token = state.token;
    else input.url = url;

    $('url').blur();
    setBusy(true);
    renderLoading();
    try {
      const r = await call('resolve', input);
      state.result = r;
      state.token = r.token;
      state.tokenUrl = r.url;
      $('url').value = r.url;
      renderResult(r);
      haptic('success');
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  }

  function handleError(err) {
    haptic('error');
    if (errorCode(err) === 'NOT_SUBSCRIBED') {
      if (state.subscription && err.parameters.url) state.subscription.url = err.parameters.url;
      showGate(true);
      $('result').replaceChildren();
      return;
    }
    renderError(errorText(err));
  }

  function download(url, fileName) {
    haptic('light');
    if (supports('8.0') && typeof tg.downloadFile === 'function' && /^https:\/\//i.test(url)) {
      tg.downloadFile({ url, file_name: fileName }, (accepted) => {
        if (accepted) toast('Загрузка началась');
      });
    } else if (tg && tg.openLink) {
      tg.openLink(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }

  function requestWriteAccess() {
    return new Promise((resolve) => {
      if (!supports('6.9') || typeof tg.requestWriteAccess !== 'function') return resolve(false);
      tg.requestWriteAccess((granted) => resolve(Boolean(granted)));
    });
  }

  function sendToChat(event) {
    // currentTarget is gone after the first await: capture the button now.
    return send(event && event.currentTarget, false);
  }

  async function send(button, retried) {
    if (state.busy || !state.result) return;
    const r = state.result;
    const label = button ? button.textContent : '';
    setBusy(true);
    if (button) button.textContent = 'Отправляю…';
    try {
      const out = await call('send', { token: r.token, mode: r.mode, quality: r.quality });
      if (out.status === 'sent') {
        haptic('success');
        toast('Готово — файл в чате с ботом');
      } else if (out.status === 'worker') {
        haptic('success');
        toast('Сервер взялся за дело — файл придёт в чат');
      } else if (out.status === 'too_large') {
        haptic('warning');
        toast('Для чата файл слишком большой — скачайте его на устройство');
      } else {
        haptic('error');
        toast('Не получилось — подробности в чате с ботом');
      }
    } catch (err) {
      if (errorCode(err) === 'START_BOT' && !retried && (await requestWriteAccess())) {
        setBusy(false);
        if (button) button.textContent = label;
        return await send(button, true);
      }
      if (errorCode(err) === 'NOT_SUBSCRIBED') return handleError(err);
      haptic('error');
      toast(errorText(err));
    } finally {
      setBusy(false);
      if (button) button.textContent = label;
    }
  }

  // ── history tab ────────────────────────────────────────────────────────

  async function loadHistory() {
    const list = $('history');
    list.replaceChildren(h('li', null, h('div', { class: 'card' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton', style: 'width: 50%' }))));
    $('history-empty').hidden = true;
    try {
      const { items } = await call('history');
      renderHistory(items);
    } catch (err) {
      list.replaceChildren();
      $('history-empty').hidden = false;
      $('history-empty').textContent = errorText(err);
    }
  }

  function renderHistory(items) {
    $('history').replaceChildren(
      ...items.map((item) => {
        const [label, tone] = STATUS[item.status] || [item.status, ''];
        const what = item.mode === 'a' ? 'звук' : item.quality ? qualityLabel(item.quality) : 'видео';
        const sub = [item.host, what, formatSize(item.sizeBytes), formatDate(item.createdAt)].filter(Boolean).join(' · ');
        return h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                $('url').value = item.url;
                state.token = null;
                setMode(item.mode === 'a' ? 'a' : 'v');
                $('result').replaceChildren();
                switchTab('download');
                syncInput();
              },
            },
            h('span', { class: 'item-icon', 'aria-hidden': 'true' }, item.mode === 'a' ? '🎵' : '🎬'),
            h('span', { class: 'item-body' }, h('div', { class: 'item-title' }, item.title || hostOf(item.url)), h('div', { class: 'item-sub' }, sub)),
            h('span', { class: `status ${tone}` }, label),
          ),
        );
      }),
    );
    $('history-empty').hidden = items.length > 0;
    $('history-empty').textContent = 'Здесь появятся ваши загрузки.';
    $('clear-history').hidden = items.length === 0;
  }

  function clearHistory() {
    const go = async () => {
      try {
        await call('clearHistory');
        renderHistory([]);
        haptic('success');
      } catch (err) {
        toast(errorText(err));
      }
    };
    if (supports('6.2')) tg.showConfirm('Очистить историю загрузок?', (ok) => ok && go());
    else if (window.confirm('Очистить историю загрузок?')) go();
  }

  // ── settings tab ───────────────────────────────────────────────────────

  const SETTING_OPTIONS = {
    videoQuality: () => state.options.qualities,
    audioFormat: () => state.options.audioFormats,
    audioBitrate: () => state.options.audioBitrates,
    codec: () => state.options.codecs,
  };

  function renderSettings() {
    for (const box of document.querySelectorAll('[data-setting]')) {
      const key = box.dataset.setting;
      box.replaceChildren(
        ...SETTING_OPTIONS[key]().map((value) =>
          h('button', {
            type: 'button',
            role: 'radio',
            'aria-checked': String(state.prefs && state.prefs[key] === value),
            text: key === 'videoQuality' ? qualityLabel(value) : value,
            onclick: () => saveSetting(key, value),
          }),
        ),
      );
    }
    if (state.features) {
      const f = state.features;
      $('limits').textContent = f.worker
        ? `В чат: до ${f.uploadLimitMb} МБ (YouTube и крупные файлы качает сервер). На устройство — без ограничений.`
        : `В чат: до ${f.uploadLimitMb} МБ. На устройство — без ограничений.`;
    }
  }

  async function saveSetting(key, value) {
    if (!state.prefs || state.prefs[key] === value) return;
    const before = state.prefs;
    state.prefs = { ...before, [key]: value };
    if (key === 'videoQuality') {
      state.quality = value;
      renderQuality();
    }
    haptic('select');
    renderSettings();
    try {
      const { prefs } = await call('saveSettings', { [key]: value });
      state.prefs = prefs;
      toast('Сохранено');
    } catch (err) {
      state.prefs = before;
      renderSettings();
      toast(errorText(err));
    }
  }

  // ── tabs, gate, start ──────────────────────────────────────────────────

  function switchTab(tab) {
    state.tab = tab;
    for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const name of ['download', 'history', 'settings']) $(`tab-${name}`).hidden = name !== tab || !$('gate').hidden;
    if (tab === 'history' && inTelegram) loadHistory();
    main.sync();
  }

  function showGate(on) {
    $('gate').hidden = !on;
    switchTab(state.tab);
  }

  function openChannel() {
    const url = state.subscription && state.subscription.url;
    if (!url) return toast('Ссылка на канал не настроена');
    if (/^https:\/\/t\.me\//i.test(url) && tg && tg.openTelegramLink) tg.openTelegramLink(url);
    else if (tg && tg.openLink) tg.openLink(url);
    else window.open(url, '_blank', 'noopener');
  }

  async function recheckSubscription() {
    try {
      const data = await call('bootstrap', {});
      state.subscription = data.subscription;
      if (data.subscription.ok) {
        haptic('success');
        showGate(false);
        toast('Подписка подтверждена');
      } else {
        haptic('warning');
        toast('Подписка пока не видна — попробуйте через пару секунд');
      }
    } catch (err) {
      toast(errorText(err));
    }
  }

  function applyBootstrap(data, startTab) {
    state.prefs = data.prefs;
    state.options = data.options;
    state.features = data.features;
    state.subscription = data.subscription;
    state.quality = data.prefs.videoQuality;
    renderQuality();
    renderSettings();
    if (data.subscription.required && !data.subscription.ok) showGate(true);
    if (startTab) switchTab(startTab);
    if (data.link) {
      $('url').value = data.link.url;
      state.token = data.link.token;
      state.tokenUrl = data.link.url;
      syncInput();
      if ($('gate').hidden) resolveLink();
    }
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        $('url').value = text.trim();
        syncInput();
        haptic('light');
      }
    } catch {
      toast('Нет доступа к буферу — вставьте ссылку вручную');
    }
  }

  function bind() {
    for (const b of document.querySelectorAll('[data-tab]')) {
      b.addEventListener('click', () => {
        haptic('select');
        switchTab(b.dataset.tab);
      });
    }
    for (const b of document.querySelectorAll('.segmented button')) {
      b.addEventListener('click', () => {
        haptic('select');
        setMode(b.dataset.mode);
      });
    }
    $('form').addEventListener('submit', (e) => {
      e.preventDefault();
      resolveLink();
    });
    $('url').addEventListener('input', syncInput);
    $('clear').addEventListener('click', () => {
      $('url').value = '';
      $('result').replaceChildren();
      state.result = null;
      syncInput();
      $('url').focus();
    });
    if (navigator.clipboard && navigator.clipboard.readText) {
      $('paste').hidden = false;
      $('paste').addEventListener('click', paste);
    }
    $('clear-history').addEventListener('click', clearHistory);
    $('gate-open').addEventListener('click', openChannel);
    $('gate-check').addEventListener('click', recheckSubscription);
  }

  async function start() {
    bind();
    renderQuality();
    renderSettings();
    const params = new URLSearchParams(location.search);
    const startTab = ['download', 'history', 'settings'].includes(params.get('tab')) ? params.get('tab') : null;

    if (tg) {
      tg.ready();
      tg.expand();
      if (supports('7.7')) tg.disableVerticalSwipes();
      applyChrome();
      tg.onEvent('themeChanged', applyChrome);
    }
    main.init();

    if (!inTelegram) {
      $('outside').hidden = false;
      $('app').setAttribute('aria-busy', 'false');
      if (startTab) switchTab(startTab);
      return;
    }

    const token = params.get('t') || (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || null;
    try {
      applyBootstrap(await call('bootstrap', token ? { token } : {}), startTab);
    } catch (err) {
      renderError(errorText(err));
    } finally {
      $('app').setAttribute('aria-busy', 'false');
    }
  }

  start();
})();
