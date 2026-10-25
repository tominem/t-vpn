'use strict';

// Flags are drawn as inline SVG rather than emoji. The TV's font covers only
// some regional-indicator pairs: measured on device, US/GB/DE/JP render at
// 50px while BR/NL/AR measure 0px wide, so those three were simply invisible.
const FLAGS = {
  us: '<rect width="24" height="16" fill="#b22234"/>'
    + '<path d="M0 2h24M0 4.6h24M0 7.2h24M0 9.8h24M0 12.4h24M0 15h24" stroke="#fff" stroke-width="1.3"/>'
    + '<rect width="10" height="8.6" fill="#3c3b6e"/>',
  br: '<rect width="24" height="16" fill="#009b3a"/>'
    + '<path d="M12 1.8 22.4 8 12 14.2 1.6 8Z" fill="#fedf00"/>'
    + '<circle cx="12" cy="8" r="3.4" fill="#002776"/>',
  gb: '<rect width="24" height="16" fill="#012169"/>'
    + '<path d="M0 0l24 16M24 0L0 16" stroke="#fff" stroke-width="3.2"/>'
    + '<path d="M0 0l24 16M24 0L0 16" stroke="#c8102e" stroke-width="1.8"/>'
    + '<path d="M12 0v16M0 8h24" stroke="#fff" stroke-width="5.4"/>'
    + '<path d="M12 0v16M0 8h24" stroke="#c8102e" stroke-width="3.2"/>',
  de: '<rect width="24" height="16" fill="#000"/>'
    + '<rect y="5.33" width="24" height="5.34" fill="#dd0000"/>'
    + '<rect y="10.67" width="24" height="5.33" fill="#ffce00"/>',
  jp: '<rect width="24" height="16" fill="#fff"/>'
    + '<circle cx="12" cy="8" r="4.8" fill="#bc002d"/>',
  nl: '<rect width="24" height="16" fill="#21468b"/>'
    + '<rect width="24" height="10.67" fill="#fff"/>'
    + '<rect width="24" height="5.33" fill="#ae1c28"/>',
  ar: '<rect width="24" height="16" fill="#74acdf"/>'
    + '<rect y="5.33" width="24" height="5.34" fill="#fff"/>'
    + '<circle cx="12" cy="8" r="2.1" fill="#f6b40e"/>',
};

/** @type {{ code: string, label: string }[]} */
const COUNTRIES = [
  { code: 'us', label: 'United States' },
  { code: 'br', label: 'Brazil' },
  { code: 'gb', label: 'United Kingdom' },
  { code: 'de', label: 'Germany' },
  { code: 'jp', label: 'Japan' },
  { code: 'nl', label: 'Netherlands' },
  { code: 'ar', label: 'Argentina' },
];

function flagSvg(code) {
  return '<svg class="flag" viewBox="0 0 24 16" aria-hidden="true">'
    + FLAGS[code] + '</svg>';
}

const SERVICE = 'luna://com.tominem.tvpn.service/';

// A call that never comes back would otherwise leave the UI stuck on
// "Connecting…" forever; the hub does occasionally drop a service.
const CALL_TIMEOUT_MS = 20000;

/**
 * Calls a Luna service method.
 *
 * Uses PalmServiceBridge, which WAM injects, rather than webOS.service.request:
 * the latter comes from the webOSTV.js SDK library, which this app does not
 * bundle, so `webOS` is simply undefined here.
 *
 * @param {string} method
 * @param {object} params
 * @returns {Promise<object>}
 */
function lunaCall(method, params) {
  return new Promise((resolve, reject) => {
    const bridge = new PalmServiceBridge();
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(method + ' timed out')),
      CALL_TIMEOUT_MS
    );

    bridge.onservicecallback = (raw) => {
      let res;
      try {
        res = JSON.parse(raw);
      } catch (e) {
        finish(reject, new Error('Malformed reply from service'));
        return;
      }
      if (res.returnValue === false) {
        finish(reject, new Error(res.errorText || res.error || 'Luna call failed'));
      } else {
        finish(resolve, res);
      }
    };

    bridge.call(SERVICE + method, JSON.stringify(params || {}));
  });
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const badge         = document.getElementById('status-badge');
const countriesDiv  = document.getElementById('countries');
const btnDisconnect = document.getElementById('btn-disconnect');
const btnAutoConn   = document.getElementById('btn-autoconnect');
const messageEl     = document.getElementById('message');

// ── State ─────────────────────────────────────────────────────────────────────

let activeCountry = null;
let autoConnectOn = false;
// An action (connect, disconnect, save) is in flight; the periodic status check
// must not redraw the screen underneath it.
let busy = false;
let polling = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setMessage(text) {
  messageEl.textContent = text;
}

function applyAutoConnect({ enabled }) {
  autoConnectOn = !!enabled;
  btnAutoConn.classList.toggle('active', autoConnectOn);
  btnAutoConn.textContent = autoConnectOn ? 'Auto-connect: ON' : 'Auto-connect: OFF';
}

const BLOCKED_TEXT =
  'VPN connection lost. Internet is blocked until you reconnect or press Disconnect.';

function applyStatus({ connected, blocked, country }) {
  activeCountry = connected ? country || null : null;

  if (blocked && !connected) {
    // The tunnel died on its own and the kill switch is holding traffic back on
    // purpose. Say so plainly: from the couch this looks like "internet is down".
    badge.textContent = 'Blocked' + (country ? ` · ${country.toUpperCase()}` : '');
    badge.className = 'badge blocked';
    setMessage(BLOCKED_TEXT);
  } else {
    // A live tunnel whose recorded country was lost still counts as connected.
    badge.textContent = connected
      ? 'Connected' + (activeCountry ? ` · ${activeCountry.toUpperCase()}` : '')
      : 'Disconnected';
    badge.className = `badge ${connected ? 'connected' : 'disconnected'}`;
    if (messageEl.textContent === BLOCKED_TEXT) setMessage('');
  }
  // Disconnect stays available while blocked: it is how the internet comes back.
  btnDisconnect.disabled = !(connected || blocked);
  btnAutoConn.disabled = !connected;

  document.querySelectorAll('.country-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.code === activeCountry);
    btn.disabled = connected && btn.dataset.code !== activeCountry;
  });

  keepFocusAlive();
}

// ── Remote control ────────────────────────────────────────────────────────────
//
// The TV's D-pad sends plain arrow keys and the OK button sends Enter. Chrome
// 53 has no spatial navigation, so without the below nothing is ever focused:
// arrows do nothing and OK has no target. Pointer clicks from the Magic Remote
// keep working as ordinary mouse events either way.

const KEY_ENTER = 13;
const KEY_LEFT = 37;
const KEY_UP = 38;
const KEY_RIGHT = 39;
const KEY_DOWN = 40;

function focusables() {
  const all = document.querySelectorAll('.country-btn, footer .btn');
  return Array.prototype.filter.call(all, (el) => !el.disabled);
}

function moveFocus(keyCode) {
  const candidates = focusables();
  if (!candidates.length) return;

  const current = candidates.indexOf(document.activeElement) >= 0
    ? document.activeElement
    : null;
  if (!current) {
    candidates[0].focus();
    return;
  }

  const from = current.getBoundingClientRect();
  const horizontal = keyCode === KEY_LEFT || keyCode === KEY_RIGHT;
  const forward = keyCode === KEY_RIGHT || keyCode === KEY_DOWN;

  let best = null;
  let bestScore = Infinity;

  candidates.forEach((el) => {
    if (el === current) return;
    const to = el.getBoundingClientRect();

    // Edge-to-edge distance in the direction pressed; negative means the
    // candidate is not that way at all.
    let along;
    if (horizontal) {
      along = forward ? to.left - from.right : from.left - to.right;
    } else {
      along = forward ? to.top - from.bottom : from.top - to.bottom;
    }
    if (along < -1) return;

    // Whether the two share any extent on the other axis, i.e. whether they
    // sit in the same row (for left/right) or column (for up/down). Anything
    // that does must win over anything that does not, or pressing right in a
    // wrapped grid drops onto the next row instead of moving along this one.
    const overlap = horizontal
      ? Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top)
      : Math.min(from.right, to.right) - Math.max(from.left, to.left);

    const drift = horizontal
      ? Math.abs((to.top + to.bottom) / 2 - (from.top + from.bottom) / 2)
      : Math.abs((to.left + to.right) / 2 - (from.left + from.right) / 2);

    // Left/right stays on its row: at the end of one, stopping reads as the
    // row ending, whereas hopping to another row looks like a glitch. Up/down
    // may cross, so a short last row still leads somewhere.
    if (horizontal && overlap <= 0) return;

    const score = (overlap > 0 ? 0 : 100000) + along + drift * 0.3;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  });

  if (best) best.focus();
}

/**
 * Connecting disables most of the grid, which can leave focus on a disabled
 * control; the remote then appears dead. Pull focus back to something usable.
 */
function keepFocusAlive() {
  const active = document.activeElement;
  if (active && focusables().indexOf(active) >= 0) return;
  // applyStatus always leaves something enabled, so the list is never empty
  // here; slice/forEach states "focus the first one, if any" without a branch.
  focusables().slice(0, 1).forEach((el) => el.focus());
}

document.addEventListener('keydown', (event) => {
  const code = event.keyCode;

  if (code === KEY_LEFT || code === KEY_UP || code === KEY_RIGHT || code === KEY_DOWN) {
    event.preventDefault();
    moveFocus(code);
    return;
  }

  // OK is activated explicitly rather than left to the browser's native
  // Enter-on-button handling, which is not dependable across the remote's
  // pointer and D-pad modes. preventDefault stops a native activation from
  // also firing and connecting twice.
  if (code === KEY_ENTER) {
    const target = document.activeElement;
    if (target && focusables().indexOf(target) >= 0) {
      event.preventDefault();
      target.click();
    }
  }
});

// ── Build country buttons ─────────────────────────────────────────────────────

COUNTRIES.forEach(({ code, label }) => {
  const btn = document.createElement('button');
  btn.className = 'country-btn';
  btn.dataset.code = code;
  btn.innerHTML = flagSvg(code) + '<span>' + label + '</span>';

  btn.addEventListener('click', async () => {
    busy = true;
    setMessage(`Connecting to ${label}…`);
    badge.className = 'badge connecting';
    badge.textContent = 'Connecting…';
    document.querySelectorAll('.country-btn').forEach((b) => (b.disabled = true));
    btnDisconnect.disabled = true;

    try {
      const result = await lunaCall('connect', { country: code });
      if (!result.ok) throw new Error(result.error);
      setMessage('');
      applyStatus({ connected: true, country: code });
    } catch (err) {
      setMessage(`Error: ${err.message}`);
      refreshStatus();
    } finally {
      busy = false;
    }
  });

  countriesDiv.appendChild(btn);
});

// ── Disconnect ────────────────────────────────────────────────────────────────

btnDisconnect.addEventListener('click', async () => {
  busy = true;
  setMessage('Disconnecting…');
  try {
    await lunaCall('disconnect');
    setMessage('');
    applyStatus({ connected: false, country: null });
  } catch (err) {
    setMessage(`Error: ${err.message}`);
  } finally {
    busy = false;
  }
});

// ── Auto-connect toggle ───────────────────────────────────────────────────────

btnAutoConn.addEventListener('click', async () => {
  busy = true;
  const enabling = !autoConnectOn;
  try {
    if (enabling) {
      await lunaCall('setAutoConnect', { enabled: true, country: activeCountry });
      setMessage('Auto-connect saved. TV will connect to this server on next boot.');
    } else {
      await lunaCall('setAutoConnect', { enabled: false });
      setMessage('Auto-connect disabled.');
    }
    applyAutoConnect({ enabled: enabling });
  } catch (err) {
    setMessage(`Error: ${err.message}`);
  } finally {
    busy = false;
  }
});

// ── Poll status on load ───────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const [statusResult, acResult] = await Promise.all([
      lunaCall('status'),
      lunaCall('getAutoConnect'),
    ]);
    applyStatus(statusResult);
    applyAutoConnect(acResult);
  } catch (err) {
    // WAM here is Chrome 53, where a binding-less `catch {}` is a parse error
    // that takes the whole script down. Keep the binding.
    setMessage('Could not reach the VPN service: ' + err.message);
    applyStatus({ connected: false, country: null });
  }
}

// ── Notice a tunnel that dies while the app is open ───────────────────────────
//
// Status was only read on load and after an action, so a tunnel dying under an
// open screen went unnoticed, and with the kill switch armed that reads as a
// dead TV. A light periodic check fixes it. It never overlaps itself, never
// runs during an action, and a missed answer changes nothing: failing to hear
// from the service says nothing about the tunnel, and flipping the screen to
// "Disconnected" on a hiccup would be a lie.

const POLL_MS = 10000;

async function pollStatus() {
  if (busy || polling) return;
  polling = true;
  try {
    const status = await lunaCall('status');
    // An action may have started while this was in flight; it owns the screen.
    if (!busy) applyStatus(status);
  } catch (err) {
    // Keep showing the last known state.
  } finally {
    polling = false;
  }
}

setInterval(pollStatus, POLL_MS);

// Give the remote something to start from: refreshStatus() may take a moment,
// and until something has focus the D-pad has nothing to move from.
keepFocusAlive();

refreshStatus();
