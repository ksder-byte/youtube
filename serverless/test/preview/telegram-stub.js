// Stand-in for telegram-web-app.js in the local preview: just enough of
// Telegram.WebApp for the Mini App to run in a normal browser. Serverless.call
// goes to the preview server, which runs the real endpoints.
(() => {
  const params = new URLSearchParams(location.search);
  const listeners = {};

  function bottomButton() {
    const el = document.createElement('button');
    el.id = 'tg-main-button';
    el.hidden = true;
    el.style.cssText =
      'position:fixed;left:12px;right:12px;bottom:12px;height:48px;border:0;border-radius:12px;' +
      'background:var(--tg-theme-button-color,#2481cc);color:#fff;font:600 15px system-ui;z-index:20';
    const mount = () => document.body.append(el);
    if (document.body) mount();
    else document.addEventListener('DOMContentLoaded', mount);
    let handler = null;
    let text = '';
    el.addEventListener('click', () => !el.disabled && handler && handler());
    return {
      setText(t) { text = t; el.textContent = t; return this; },
      onClick(fn) { handler = fn; return this; },
      show() { el.hidden = false; return this; },
      hide() { el.hidden = true; return this; },
      enable() { el.disabled = false; el.style.opacity = 1; return this; },
      disable() { el.disabled = true; el.style.opacity = 0.6; return this; },
      showProgress() { el.textContent = '…'; return this; },
      hideProgress() { el.textContent = text; return this; },
      get isVisible() { return !el.hidden; },
    };
  }

  window.__tg = { downloads: [], opened: [] };

  window.Telegram = {
    WebApp: {
      initData: 'user=preview&hash=stub',
      initDataUnsafe: { user: { id: 42, first_name: 'Ann' }, start_param: params.get('startapp') || undefined },
      version: '9.6',
      platform: 'web',
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      themeParams: {},
      isVersionAtLeast: () => true,
      ready() {},
      expand() {},
      disableVerticalSwipes() {},
      setHeaderColor() {},
      setBackgroundColor() {},
      setBottomBarColor() {},
      onEvent(name, fn) { (listeners[name] ||= []).push(fn); },
      HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
      MainButton: bottomButton(),
      showConfirm(message, cb) { cb(window.confirm(message)); },
      openLink(url) { window.__tg.opened.push(url); },
      openTelegramLink(url) { window.__tg.opened.push(url); },
      downloadFile(p, cb) { window.__tg.downloads.push(p); cb(true); },
      requestWriteAccess(cb) { cb(true); },
      Serverless: {
        call(name, input, cb) {
          if (typeof input === 'function') [cb, input] = [input, {}];
          fetch(`/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input ?? {}) })
            .then((r) => r.json().then((d) => [r.status, d]))
            .then(([status, d]) => {
              if (d.ok) return cb(null, d.result);
              const err = new Error(d.description);
              err.type = d.error_type;
              err.status = status;
              err.parameters = d.parameters;
              cb(err);
            })
            .catch((e) => {
              const err = new Error(e.message);
              err.status = 0;
              cb(err);
            });
        },
      },
    },
  };
})();
