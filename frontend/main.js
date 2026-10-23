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

/**
 * Calls a Luna service method.
 * webOS exposes webOSTV.service.request() in the WAM runtime.
 *
 * @param {string} method
 * @param {object} params
 * @returns {Promise<object>}
 */
function lunaCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    webOS.service.request(SERVICE + method, {
      parameters: params,
      onSuccess: resolve,
      onFailure: (e) => reject(new Error(e.errorText || 'Luna call failed')),
    });
  });
}

// ── DOM refs ──────────────────────────────────────────────────────────────────

const badge        = document.getElementById('status-badge');
const countriesDiv = document.getElementById('countries');
const btnDisconnect = document.getElementById('btn-disconnect');
const messageEl    = document.getElementById('message');

// ── State ─────────────────────────────────────────────────────────────────────

let activeCountry = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setMessage(text) {
  messageEl.textContent = text;
}

function applyStatus({ connected, country }) {
  activeCountry = connected ? country : null;

  badge.textContent = connected ? `Connected · ${country.toUpperCase()}` : 'Disconnected';
  badge.className = `badge ${connected ? 'connected' : 'disconnected'}`;
  btnDisconnect.disabled = !connected;

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

// ── Poll status on load ───────────────────────────────────────────────────────

async function refreshStatus() {
  try {
    const result = await lunaCall('status');
    applyStatus(result);
  } catch {
    applyStatus({ connected: false, country: null });
  }
}

refreshStatus();
