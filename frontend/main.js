'use strict';

/** @type {{ code: string, label: string }[]} */
const COUNTRIES = [
  { code: 'us', label: '🇺🇸 United States' },
  { code: 'br', label: '🇧🇷 Brazil' },
  { code: 'gb', label: '🇬🇧 United Kingdom' },
  { code: 'de', label: '🇩🇪 Germany' },
  { code: 'jp', label: '🇯🇵 Japan' },
  { code: 'nl', label: '🇳🇱 Netherlands' },
  { code: 'ar', label: '🇦🇷 Argentina' },
];

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function setMessage(text) {
  messageEl.textContent = text;
}

function applyAutoConnect({ enabled }) {
  autoConnectOn = !!enabled;
  btnAutoConn.classList.toggle('active', autoConnectOn);
  btnAutoConn.textContent = autoConnectOn ? 'Auto-connect: ON' : 'Auto-connect: OFF';
}

function applyStatus({ connected, country }) {
  activeCountry = connected ? country || null : null;

  // A live tunnel whose recorded country was lost still counts as connected.
  badge.textContent = connected
    ? 'Connected' + (activeCountry ? ` · ${activeCountry.toUpperCase()}` : '')
    : 'Disconnected';
  badge.className = `badge ${connected ? 'connected' : 'disconnected'}`;
  btnDisconnect.disabled = !connected;
  btnAutoConn.disabled = !connected;

  document.querySelectorAll('.country-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.code === activeCountry);
    btn.disabled = connected && btn.dataset.code !== activeCountry;
  });
}

// ── Build country buttons ─────────────────────────────────────────────────────

COUNTRIES.forEach(({ code, label }) => {
  const btn = document.createElement('button');
  btn.className = 'country-btn';
  btn.dataset.code = code;
  btn.textContent = label;

  btn.addEventListener('click', async () => {
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
    }
  });

  countriesDiv.appendChild(btn);
});

// ── Disconnect ────────────────────────────────────────────────────────────────

btnDisconnect.addEventListener('click', async () => {
  setMessage('Disconnecting…');
  try {
    await lunaCall('disconnect');
    setMessage('');
    applyStatus({ connected: false, country: null });
  } catch (err) {
    setMessage(`Error: ${err.message}`);
  }
});

// ── Auto-connect toggle ───────────────────────────────────────────────────────

btnAutoConn.addEventListener('click', async () => {
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

refreshStatus();
