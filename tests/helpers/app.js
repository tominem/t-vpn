/**
 * Loads the real frontend into jsdom the way WAM does: index.html for the
 * markup, then main.js executed against it, with the Luna bridge faked.
 *
 * main.js is a plain script with top-level side effects and no exports, so it
 * is executed rather than required, and the tests then drive it through the
 * DOM exactly as the remote and the pointer do.
 */
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

/**
 * Fake PalmServiceBridge. Records every call and lets the test decide what
 * each method replies with, including replying never, which is how a wedged
 * Luna hub behaves.
 */
function makeBridge() {
  const calls = [];
  const replies = new Map();
  let autoReply = null;

  function PalmServiceBridge() {
    this.onservicecallback = null;
  }

  PalmServiceBridge.prototype.call = function (uri, payload) {
    const method = uri.split('/').pop();
    const record = { uri, method, params: JSON.parse(payload), bridge: this };
    calls.push(record);

    const reply = replies.has(method) ? replies.get(method) : autoReply;
    if (reply === undefined || reply === null) return; // never answers
    // Luna answers asynchronously; keep that so awaits behave as on device.
    Promise.resolve().then(() => {
      if (this.onservicecallback) {
        this.onservicecallback(typeof reply === 'string' ? reply : JSON.stringify(reply));
      }
    });
  };

  return {
    PalmServiceBridge,
    calls,
    callsTo: (method) => calls.filter((c) => c.method === method),
    reply: (method, value) => replies.set(method, value),
    replyToAll: (value) => { autoReply = value; },
    neverReply: (method) => replies.set(method, null),
  };
}

/**
 * Positions used for focus movement. jsdom lays nothing out, so every rect is
 * zero and the geometric navigation has nothing to work with; these mirror the
 * real screen: five buttons on the first row, two on the second, footer below.
 */
const LAYOUT = {
  us: { left: 100, right: 413, top: 258, bottom: 347 },
  br: { left: 437, right: 660, top: 258, bottom: 347 },
  gb: { left: 684, right: 1025, top: 258, bottom: 347 },
  de: { left: 1049, right: 1310, top: 258, bottom: 347 },
  jp: { left: 1334, right: 1562, top: 258, bottom: 347 },
  nl: { left: 100, right: 399, top: 367, bottom: 456 },
  ar: { left: 423, right: 695, top: 367, bottom: 456 },
  'btn-disconnect': { left: 100, right: 340, top: 937, bottom: 1026 },
  'btn-autoconnect': { left: 381, right: 715, top: 937, bottom: 1026 },
};

function applyLayout(document) {
  const place = (el, box) => {
    el.getBoundingClientRect = () => ({
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.right - box.left,
      height: box.bottom - box.top,
    });
  };
  document.querySelectorAll('.country-btn').forEach((el) => {
    const box = LAYOUT[el.dataset.code];
    if (box) place(el, box);
  });
  ['btn-disconnect', 'btn-autoconnect'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) place(el, LAYOUT[id]);
  });
}

/**
 * @param {object} [options]
 * @param {object} [options.status] reply for the status method
 * @param {object} [options.autoConnect] reply for getAutoConnect
 */
function loadApp(options = {}) {
  const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
  const body = html.replace(/[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*/, '');
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');

  const bridge = makeBridge();
  global.PalmServiceBridge = bridge.PalmServiceBridge;

  bridge.reply('status', Object.assign(
    { returnValue: true, connected: false, country: null, pid: null },
    options.status
  ));
  bridge.reply('getAutoConnect', Object.assign(
    { returnValue: true, enabled: false, country: null },
    options.autoConnect
  ));
  (options.silent || []).forEach((method) => bridge.neverReply(method));

  // Chrome drops focus from a control the moment it becomes disabled; jsdom
  // leaves it in place. Without imitating that, the very situation that left
  // the remote looking dead (focus stranded after the grid is disabled)
  // cannot arise here and tests of the recovery pass vacuously.
  const buttonProto = window.HTMLButtonElement.prototype;
  const realDisabled = Object.getOwnPropertyDescriptor(buttonProto, 'disabled');
  Object.defineProperty(buttonProto, 'disabled', {
    configurable: true,
    get: realDisabled.get,
    set(value) {
      // Blur first: jsdom ignores blur() on an element that is no longer
      // focusable, so doing it after the assignment silently did nothing.
      if (value && document.activeElement === this) this.blur();
      realDisabled.set.call(this, value);
    },
  });

  // Listeners the script puts on `document` outlive clearing the body, so
  // they are recorded and removed between tests; otherwise a second load
  // leaves the first still handling keys and OK fires twice.
  const added = [];
  const realAdd = document.addEventListener.bind(document);
  document.addEventListener = (type, fn, opts) => {
    added.push([type, fn, opts]);
    realAdd(type, fn, opts);
  };

  // Loaded through jest's module system, not eval'd, so coverage instruments
  // it (code built with `new Function` is invisible to istanbul). isolateModules
  // gives every load a fresh module scope: the script's top-level const bindings
  // do not collide on the second load, and its top-level side effects run again.
  try {
    jest.isolateModules(() => {
      require(path.join(FRONTEND, 'main.js'));
    });
  } finally {
    document.addEventListener = realAdd;
  }

  applyLayout(document);

  bridge.cleanup = () => {
    added.forEach(([type, fn, opts]) => document.removeEventListener(type, fn, opts));
    Object.defineProperty(buttonProto, 'disabled', realDisabled);
  };
  return bridge;
}

/** Presses a key the way the TV remote's D-pad does. */
function press(keyCode) {
  const event = new window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
  });
  // jsdom will not set keyCode from the init dict.
  Object.defineProperty(event, 'keyCode', { get: () => keyCode });
  document.dispatchEvent(event);
  return event;
}

const KEY = { ENTER: 13, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40 };

/** What currently has focus, named the way the tests talk about it. */
function focused() {
  const el = document.activeElement;
  if (!el || el === document.body) return 'body';
  return el.dataset && el.dataset.code ? el.dataset.code : el.id;
}

/** Lets pending promise callbacks run, as an await would on device. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

module.exports = { loadApp, press, focused, settle, KEY, LAYOUT };
