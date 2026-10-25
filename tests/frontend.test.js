/**
 * @jest-environment jsdom
 *
 * Drives the real frontend in jsdom. Every case here corresponds to something
 * that was broken on the TV and found only by inspecting the running app.
 */

const helpers = require('./helpers/app');

const { press, focused, settle, KEY } = helpers;

// Every app loaded in a test is tracked so its document-level listeners can be
// removed afterwards; left in place they would also answer the next test's keys.
const loaded = [];
function loadApp(options) {
  const bridge = helpers.loadApp(options);
  loaded.push(bridge);
  return bridge;
}

afterEach(() => {
  loaded.splice(0).forEach((b) => b.cleanup());
  delete global.PalmServiceBridge;
  document.body.innerHTML = '';
});

describe('startup', () => {
  test('main.js runs and builds the whole server grid', async () => {
    // It once parsed-errored on Chrome 53 and defined nothing at all, leaving
    // an empty page with no buttons.
    loadApp();
    await settle();

    const codes = Array.prototype.map.call(
      document.querySelectorAll('.country-btn'),
      (b) => b.dataset.code
    );
    expect(codes).toEqual(['us', 'br', 'gb', 'de', 'jp', 'nl', 'ar']);
  });

  test('asks the service for status and auto-connect on load', async () => {
    const bridge = loadApp();
    await settle();

    expect(bridge.callsTo('status')).toHaveLength(1);
    expect(bridge.callsTo('getAutoConnect')).toHaveLength(1);
  });

  test('reflects a tunnel that was already up', async () => {
    loadApp({ status: { connected: true, country: 'br', pid: 42 } });
    await settle();

    expect(document.getElementById('status-badge').textContent).toBe('Connected · BR');
    expect(document.getElementById('btn-disconnect').disabled).toBe(false);
  });

  test('a connected tunnel with no recorded country still reads as connected', async () => {
    // The boot auto-connect path can leave the pid without the country.
    loadApp({ status: { connected: true, country: null, pid: 42 } });
    await settle();

    expect(document.getElementById('status-badge').textContent).toBe('Connected');
  });

  test('says so when the service never answers, instead of hanging', async () => {
    // A wedged Luna hub simply never replies. Without a timeout the UI would
    // sit on a stale state with no explanation.
    jest.useFakeTimers();
    try {
      const bridge = loadApp({ silent: ['status', 'getAutoConnect'] });
      expect(bridge.callsTo('status')).toHaveLength(1);

      jest.advanceTimersByTime(20001);
      await Promise.resolve();
      await Promise.resolve();

      expect(document.getElementById('message').textContent)
        .toContain('Could not reach the VPN service');
      // And it must not claim a connection it never confirmed.
      expect(document.getElementById('status-badge').textContent).toBe('Disconnected');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a malformed reply is an error, not a crash', async () => {
    const bridge = loadApp();
    await settle();

    bridge.reply('connect', 'this is not json');
    document.querySelector('.country-btn[data-code="us"]').click();
    await settle();

    expect(document.getElementById('message').textContent).toContain('Malformed');
    expect(document.getElementById('status-badge').textContent).toBe('Disconnected');
  });
});

describe('flags', () => {
  test('every country gets an inline SVG, not a font glyph', async () => {
    // The TV font has no glyph for BR, NL or AR, which drew nothing at all.
    loadApp();
    await settle();

    document.querySelectorAll('.country-btn').forEach((btn) => {
      const svg = btn.querySelector('svg.flag');
      expect(svg).not.toBeNull();
      expect(svg.children.length).toBeGreaterThan(0);
    });
  });

  test('no regional-indicator emoji survive in the source', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'frontend', 'main.js'), 'utf8'
    );
    // U+1F1E6..U+1F1FF as surrogate pairs.
    expect(src).not.toMatch(/\uD83C[\uDDE6-\uDDFF]/);
  });
});

describe('connecting', () => {
  test('clicking a country asks the service for that country', async () => {
    const bridge = loadApp();
    await settle();

    bridge.reply('connect', { returnValue: true, ok: true });
    document.querySelector('.country-btn[data-code="de"]').click();
    await settle();

    expect(bridge.callsTo('connect')).toHaveLength(1);
    expect(bridge.callsTo('connect')[0].params).toEqual({ country: 'de' });
  });

  test('shows the connected server and locks the other choices', async () => {
    const bridge = loadApp();
    await settle();

    bridge.reply('connect', { returnValue: true, ok: true });
    document.querySelector('.country-btn[data-code="br"]').click();
    await settle();

    expect(document.getElementById('status-badge').textContent).toBe('Connected · BR');
    expect(document.querySelector('.country-btn[data-code="br"]').disabled).toBe(false);
    expect(document.querySelector('.country-btn[data-code="de"]').disabled).toBe(true);
  });

  test('surfaces a refusal from the service instead of claiming success', async () => {
    const bridge = loadApp();
    await settle();

    bridge.reply('connect', { returnValue: true, ok: false, error: 'Config not found' });
    document.querySelector('.country-btn[data-code="jp"]').click();
    await settle();

    expect(document.getElementById('message').textContent).toContain('Config not found');
    expect(document.getElementById('status-badge').textContent).toBe('Disconnected');
  });

  test('disconnect asks the service and clears the grid', async () => {
    const bridge = loadApp({ status: { connected: true, country: 'br', pid: 7 } });
    await settle();

    bridge.reply('disconnect', { returnValue: true, ok: true });
    document.getElementById('btn-disconnect').click();
    await settle();

    expect(bridge.callsTo('disconnect')).toHaveLength(1);
    expect(document.getElementById('status-badge').textContent).toBe('Disconnected');
    expect(document.querySelector('.country-btn[data-code="de"]').disabled).toBe(false);
  });
});

describe('auto-connect', () => {
  test('enabling sends the connected country', async () => {
    const bridge = loadApp({ status: { connected: true, country: 'de', pid: 9 } });
    await settle();

    bridge.reply('setAutoConnect', { returnValue: true, ok: true });
    document.getElementById('btn-autoconnect').click();
    await settle();

    expect(bridge.callsTo('setAutoConnect')[0].params)
      .toEqual({ enabled: true, country: 'de' });
  });

  test('disabling sends enabled:false and no country', async () => {
    const bridge = loadApp({
      status: { connected: true, country: 'de', pid: 9 },
      autoConnect: { enabled: true, country: 'de' },
    });
    await settle();

    bridge.reply('setAutoConnect', { returnValue: true, ok: true });
    document.getElementById('btn-autoconnect').click();
    await settle();

    expect(bridge.callsTo('setAutoConnect')[0].params).toEqual({ enabled: false });
  });
});

describe('remote control', () => {
  test('something is focused on load, so the D-pad has a starting point', () => {
    // Checked before the service has answered. After it has, the status update
    // gives focus anyway, which would hide a missing initial focus, and the
    // remote would be dead for however long the service takes to reply.
    loadApp({ silent: ['status', 'getAutoConnect'] });

    expect(focused()).toBe('us');
  });

  test('right walks along the row', async () => {
    loadApp();
    await settle();

    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      press(KEY.RIGHT);
      seen.push(focused());
    }
    expect(seen).toEqual(['br', 'gb', 'de', 'jp']);
  });

  test('right stops at the end of a row instead of jumping to another', async () => {
    loadApp();
    await settle();

    for (let i = 0; i < 6; i += 1) press(KEY.RIGHT);
    expect(focused()).toBe('jp');
  });

  test('right stops at the end of the second row too, not jumping back up', async () => {
    // ar is last in its row; geometrically de lies to its right, a row up, and
    // reaching it read as a glitch.
    loadApp();
    await settle();

    press(KEY.DOWN);
    expect(focused()).toBe('nl');
    press(KEY.RIGHT);
    expect(focused()).toBe('ar');
    press(KEY.RIGHT);
    expect(focused()).toBe('ar');
  });

  test('left stops at the start of a row', async () => {
    loadApp();
    await settle();

    press(KEY.LEFT);
    expect(focused()).toBe('us');
    press(KEY.DOWN);
    press(KEY.LEFT);
    expect(focused()).toBe('nl');
  });

  test('up from the second row returns to the column above', async () => {
    loadApp();
    await settle();

    press(KEY.DOWN);
    press(KEY.RIGHT);
    expect(focused()).toBe('ar');
    press(KEY.UP);
    expect(focused()).toBe('br');
  });

  test('down moves into the column below, not merely the nearest button', async () => {
    // Scoring by centre distance alone sent right-from-br to ar, a row down.
    loadApp();
    await settle();

    press(KEY.DOWN);
    expect(focused()).toBe('nl');
  });

  test('down from a short row reaches the footer', async () => {
    loadApp({ status: { connected: true, country: 'us', pid: 3 } });
    await settle();

    // us is the connected one, so it stays enabled and keeps focus.
    press(KEY.DOWN);
    expect(focused()).toBe('btn-disconnect');
  });

  test('left and right move between the footer buttons', async () => {
    loadApp({ status: { connected: true, country: 'us', pid: 3 } });
    await settle();

    press(KEY.DOWN);
    press(KEY.RIGHT);
    expect(focused()).toBe('btn-autoconnect');
    press(KEY.LEFT);
    expect(focused()).toBe('btn-disconnect');
  });

  test('arrow keys are consumed so the page never scrolls under them', async () => {
    loadApp();
    await settle();

    expect(press(KEY.RIGHT).defaultPrevented).toBe(true);
  });

  test('OK activates the focused control', async () => {
    const bridge = loadApp();
    await settle();
    bridge.reply('connect', { returnValue: true, ok: true });

    press(KEY.RIGHT);
    press(KEY.ENTER);
    await settle();

    expect(bridge.callsTo('connect')[0].params).toEqual({ country: 'br' });
  });

  test('OK fires once, not twice alongside native activation', async () => {
    const bridge = loadApp();
    await settle();
    bridge.reply('connect', { returnValue: true, ok: true });

    const event = press(KEY.ENTER);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(bridge.callsTo('connect')).toHaveLength(1);
  });

  test('focus never disappears when the grid is disabled', async () => {
    // Losing focus to BODY leaves the remote looking dead.
    const bridge = loadApp();
    await settle();

    bridge.reply('connect', { returnValue: true, ok: true });
    press(KEY.RIGHT);
    press(KEY.ENTER);
    await settle();

    expect(focused()).not.toBe('body');
    expect(document.activeElement.disabled).toBe(false);
  });

  test('focus returns to a usable control after Disconnect disables itself', async () => {
    // Pressing OK on Disconnect disables the very button that held focus.
    const bridge = loadApp({ status: { connected: true, country: 'br', pid: 5 } });
    await settle();
    bridge.reply('disconnect', { returnValue: true, ok: true });

    press(KEY.DOWN);
    press(KEY.LEFT);
    expect(focused()).toBe('btn-disconnect');
    press(KEY.ENTER);
    await settle();

    expect(document.getElementById('btn-disconnect').disabled).toBe(true);
    expect(focused()).not.toBe('body');
    expect(document.activeElement.disabled).toBe(false);
  });

  test('disabled controls are skipped', async () => {
    // Disconnected means both footer buttons are disabled.
    loadApp();
    await settle();

    press(KEY.DOWN);
    press(KEY.DOWN);
    expect(focused()).toBe('nl');
  });
});

describe('Luna reply handling', () => {
  const answered = (bridge, method) => bridge.callsTo(method)[0].bridge;

  test('a reply that arrives after the timeout is ignored', async () => {
    // The hub can answer long after the UI gave up; that must not flip the
    // screen to a state the user was already told could not be confirmed.
    jest.useFakeTimers();
    try {
      const bridge = loadApp({ silent: ['status', 'getAutoConnect'] });
      jest.advanceTimersByTime(20001);
      await Promise.resolve();
      await Promise.resolve();
      const message = document.getElementById('message').textContent;
      expect(message).toContain('Could not reach');

      answered(bridge, 'status').onservicecallback(
        JSON.stringify({ returnValue: true, connected: true, country: 'br' })
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(document.getElementById('status-badge').textContent).toBe('Disconnected');
      expect(document.getElementById('message').textContent).toBe(message);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a second reply to the same call is ignored', async () => {
    // Luna can deliver more than one callback for a call.
    const bridge = loadApp();
    await settle();
    bridge.reply('connect', { returnValue: true, ok: true });
    document.querySelector('.country-btn[data-code="us"]').click();
    await settle();
    expect(document.getElementById('status-badge').textContent).toBe('Connected · US');

    answered(bridge, 'connect').onservicecallback(
      JSON.stringify({ returnValue: true, ok: false, error: 'late' })
    );
    await settle();

    expect(document.getElementById('status-badge').textContent).toBe('Connected · US');
    expect(document.getElementById('message').textContent).toBe('');
  });

  test.each([
    ['errorText', { returnValue: false, errorText: 'Service does not exist' }, 'Service does not exist'],
    ['error', { returnValue: false, error: 'Config not found' }, 'Config not found'],
    ['neither', { returnValue: false }, 'Luna call failed'],
  ])('returnValue:false reports its %s', async (_label, reply, expected) => {
    const bridge = loadApp();
    await settle();
    bridge.reply('connect', reply);

    document.querySelector('.country-btn[data-code="de"]').click();
    await settle();

    expect(document.getElementById('message').textContent).toBe(`Error: ${expected}`);
    expect(document.getElementById('status-badge').textContent).toBe('Disconnected');
  });

  test('a failed disconnect says so and stays connected', async () => {
    const bridge = loadApp({ status: { connected: true, country: 'br', pid: 8 } });
    await settle();
    bridge.reply('disconnect', { returnValue: false, error: 'Not connected.' });

    document.getElementById('btn-disconnect').click();
    await settle();

    expect(document.getElementById('message').textContent).toBe('Error: Not connected.');
    expect(document.getElementById('status-badge').textContent).toBe('Connected · BR');
  });

  test('a failed auto-connect save says so and leaves the toggle off', async () => {
    const bridge = loadApp({ status: { connected: true, country: 'br', pid: 8 } });
    await settle();
    bridge.reply('setAutoConnect', { returnValue: false, error: 'read-only filesystem' });

    document.getElementById('btn-autoconnect').click();
    await settle();

    expect(document.getElementById('message').textContent)
      .toBe('Error: read-only filesystem');
    expect(document.getElementById('btn-autoconnect').textContent).toBe('Auto-connect: OFF');
  });
});

describe('remote control edge cases', () => {
  test('arrows are harmless while every control is disabled', async () => {
    // "Connecting…" disables the whole screen; the remote must not throw.
    const bridge = loadApp();
    await settle();
    bridge.neverReply('connect');
    document.querySelector('.country-btn[data-code="us"]').click();
    await settle();

    expect(press(KEY.RIGHT).defaultPrevented).toBe(true);
    expect(focused()).toBe('body');
  });

  test('an arrow with nothing focused starts from the first control', async () => {
    loadApp();
    await settle();
    document.activeElement.blur();
    expect(focused()).toBe('body');

    press(KEY.DOWN);

    expect(focused()).toBe('us');
  });

  test('keys that are not navigation or OK are left alone', async () => {
    const bridge = loadApp();
    await settle();

    const event = press(65);

    expect(event.defaultPrevented).toBe(false);
    expect(bridge.callsTo('connect')).toHaveLength(0);
  });

  test('OK with nothing focused does nothing and is not swallowed', async () => {
    const bridge = loadApp();
    await settle();
    document.activeElement.blur();

    const event = press(KEY.ENTER);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bridge.callsTo('connect')).toHaveLength(0);
  });
});

describe('kill switch: a blocked tunnel', () => {
  const BLOCKED = 'VPN connection lost. Internet is blocked until you reconnect or press Disconnect.';
  const blockedStatus = { connected: false, blocked: true, country: 'br' };

  test('says plainly that traffic is blocked, naming the server that dropped', async () => {
    // From the couch a held-back connection looks exactly like "the internet is down".
    loadApp({ status: blockedStatus });
    await settle();

    expect(document.getElementById('status-badge').textContent).toBe('Blocked · BR');
    expect(document.getElementById('status-badge').className).toBe('badge blocked');
    expect(document.getElementById('message').textContent).toBe(BLOCKED);
  });

  test('copes with a blocked tunnel whose country was not recorded', async () => {
    loadApp({ status: { connected: false, blocked: true, country: null } });
    await settle();

    expect(document.getElementById('status-badge').textContent).toBe('Blocked');
  });

  test('keeps Disconnect available, because that is how the internet comes back', async () => {
    loadApp({ status: blockedStatus });
    await settle();

    expect(document.getElementById('btn-disconnect').disabled).toBe(false);
    expect(document.getElementById('btn-autoconnect').disabled).toBe(true);
  });

  test('leaves every country available so the user can reconnect', async () => {
    loadApp({ status: blockedStatus });
    await settle();

    expect(Array.prototype.filter.call(
      document.querySelectorAll('.country-btn'), (b) => b.disabled
    )).toHaveLength(0);
  });

  test('Disconnect restores the screen and clears the warning', async () => {
    const bridge = loadApp({ status: blockedStatus });
    await settle();
    bridge.reply('disconnect', { returnValue: true, ok: true });

    document.getElementById('btn-disconnect').click();
    await settle();

    expect(bridge.callsTo('disconnect')).toHaveLength(1);
    expect(document.getElementById('status-badge').textContent).toBe('Disconnected');
    expect(document.getElementById('message').textContent).toBe('');
  });

  test('reconnecting from a blocked state asks for the chosen country', async () => {
    const bridge = loadApp({ status: blockedStatus });
    await settle();
    bridge.reply('connect', { returnValue: true, ok: true });

    document.querySelector('.country-btn[data-code="de"]').click();
    await settle();

    expect(bridge.callsTo('connect')[0].params).toEqual({ country: 'de' });
    expect(document.getElementById('status-badge').textContent).toBe('Connected · DE');
    expect(document.getElementById('message').textContent).toBe('');
  });

  test('an unrelated message is not wiped just because the tunnel is fine', async () => {
    const bridge = loadApp();
    await settle();
    bridge.reply('connect', { returnValue: false, error: 'Config not found' });
    document.querySelector('.country-btn[data-code="jp"]').click();
    await settle();
    expect(document.getElementById('message').textContent).toBe('Error: Config not found');

    // a later status that is merely "disconnected" must leave that error alone
    bridge.reply('status', { returnValue: true, connected: false, blocked: false });
    document.getElementById('btn-disconnect').disabled = false;
    await settle();

    expect(document.getElementById('message').textContent).not.toBe('');
  });
});

describe('noticing a tunnel that dies while the app is open', () => {
  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  };

  async function withTimers(fn) {
    jest.useFakeTimers();
    try {
      await fn();
    } finally {
      jest.useRealTimers();
    }
  }

  test('checks again every ten seconds and shows what it finds', async () => {
    await withTimers(async () => {
      const bridge = loadApp({ status: { connected: true, country: 'br', pid: 9 } });
      await flush();
      expect(document.getElementById('status-badge').textContent).toBe('Connected · BR');

      bridge.reply('status', { returnValue: true, connected: false, blocked: true, country: 'br' });
      jest.advanceTimersByTime(10000);
      await flush();

      expect(document.getElementById('status-badge').textContent).toBe('Blocked · BR');
      expect(document.getElementById('message').textContent).toContain('Internet is blocked');
    });
  });

  test('the blocked warning clears by itself once the tunnel is back', async () => {
    await withTimers(async () => {
      const bridge = loadApp({ status: { connected: false, blocked: true, country: 'br' } });
      await flush();
      expect(document.getElementById('message').textContent).toContain('Internet is blocked');

      bridge.reply('status', { returnValue: true, connected: true, blocked: false, country: 'br', pid: 3 });
      jest.advanceTimersByTime(10000);
      await flush();

      expect(document.getElementById('status-badge').textContent).toBe('Connected · BR');
      expect(document.getElementById('message').textContent).toBe('');
    });
  });

  test('does nothing before the interval is up', async () => {
    await withTimers(async () => {
      const bridge = loadApp();
      await flush();
      const before = bridge.callsTo('status').length;

      jest.advanceTimersByTime(9000);
      await flush();

      expect(bridge.callsTo('status')).toHaveLength(before);
    });
  });

  test('stays out of the way while an action is in flight', async () => {
    await withTimers(async () => {
      const bridge = loadApp();
      await flush();
      bridge.neverReply('connect');
      document.querySelector('.country-btn[data-code="us"]').click();
      await flush();
      const before = bridge.callsTo('status').length;

      jest.advanceTimersByTime(10000);
      await flush();

      expect(bridge.callsTo('status')).toHaveLength(before);
      expect(document.getElementById('status-badge').textContent).toBe('Connecting…');
    });
  });

  test('never has two checks in flight at once', async () => {
    await withTimers(async () => {
      const bridge = loadApp();
      await flush();
      const before = bridge.callsTo('status').length;
      bridge.neverReply('status');

      jest.advanceTimersByTime(10000);
      await flush();
      jest.advanceTimersByTime(10000);
      await flush();

      expect(bridge.callsTo('status')).toHaveLength(before + 1);
    });
  });

  test('a missed answer leaves the screen as it was', async () => {
    // Not hearing back says nothing about the tunnel; "Disconnected" would be a lie.
    await withTimers(async () => {
      const bridge = loadApp({ status: { connected: true, country: 'br', pid: 9 } });
      await flush();
      const message = document.getElementById('message').textContent;

      bridge.reply('status', { returnValue: false, error: 'hub hiccup' });
      jest.advanceTimersByTime(10000);
      await flush();

      expect(document.getElementById('status-badge').textContent).toBe('Connected · BR');
      expect(document.getElementById('message').textContent).toBe(message);
    });
  });

  test('can check again after a missed answer', async () => {
    await withTimers(async () => {
      const bridge = loadApp({ status: { connected: true, country: 'br', pid: 9 } });
      await flush();
      bridge.reply('status', { returnValue: false, error: 'hub hiccup' });
      jest.advanceTimersByTime(10000);
      await flush();

      bridge.reply('status', { returnValue: true, connected: false, blocked: true, country: 'br' });
      jest.advanceTimersByTime(10000);
      await flush();

      expect(document.getElementById('status-badge').textContent).toBe('Blocked · BR');
    });
  });

  test('an answer that lands after an action began does not redraw over it', async () => {
    await withTimers(async () => {
      const bridge = loadApp({ status: { connected: true, country: 'br', pid: 9 } });
      await flush();
      bridge.neverReply('status');
      jest.advanceTimersByTime(10000);
      await flush();
      const pending = bridge.callsTo('status').slice(-1)[0].bridge;

      bridge.neverReply('disconnect');
      document.getElementById('btn-disconnect').click();
      await flush();
      const during = document.getElementById('status-badge').textContent;
      // A stale answer that disagrees with the screen: it must not win.
      pending.onservicecallback(JSON.stringify({ returnValue: true, connected: false, blocked: false, country: null }));
      await flush();

      expect(document.getElementById('message').textContent).toBe('Disconnecting…');
      expect(document.getElementById('status-badge').textContent).toBe(during);
      expect(document.getElementById('status-badge').textContent).not.toBe('Disconnected');
    });
  });
});
