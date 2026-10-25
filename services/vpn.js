'use strict';

var childProcess = require('child_process');
var spawn = childProcess.spawn;
var spawnSync = childProcess.spawnSync;
var fs = require('fs');
var path = require('path');

var STARTUP_SCRIPT_PATH = '/var/lib/webosbrew/init.d/99-tvpn';
var LOG_PATH = '/tmp/tvpn-openvpn.log';
var STATE_PATH = '/tmp/tvpn-state.json';
var PID_PATH = '/tmp/tvpn-openvpn.pid';
var SPAWN_ERR_PATH = '/tmp/tvpn-spawn-error.log';
// Redirects the resolver to the pushed DNS while connected; without it the
// tunnel leaks every lookup to the ISP. See the script for the details.
var HOOK_SCRIPT = path.join(__dirname, 'tvpn-updown.sh');
// Armed by the hook once the tunnel is up and left armed if the tunnel dies, so
// traffic cannot leak; only a deliberate disconnect or a reconnect lifts it.
var KILL_SCRIPT = path.join(__dirname, 'tvpn-killswitch.sh');
var KILL_MARKER = '/tmp/tvpn-killswitch';

// Shared by connect() and the boot-time auto-connect runner, so the two paths
// cannot drift apart. They did once: auto-connect was built separately and
// came up without the DNS hooks, leaking every lookup after a reboot.
//
// --daemon is required rather than merely convenient: the Luna service exits
// as soon as it has answered, and a detached child does not survive that.
// OpenVPN daemonizes itself and reports its post-fork pid via --writepid.
// --log keeps output off the service's pipes, which nothing ever drains.
var OPENVPN_FLAGS = [
  '--log', LOG_PATH,
  '--writepid', PID_PATH,
  '--script-security', '2',
  '--up', HOOK_SCRIPT,
  '--down', HOOK_SCRIPT,
  '--daemon',
];

// webOS starts Luna services with LD_PRELOAD=/usr/lib/libsystrim.so.3, a glibc
// library, and children inherit it. A musl-linked binary then dies at startup
// with "Error relocating /usr/lib/libsystrim.so.3: __register_atfork: symbol
// not found" — silently, since stderr is not kept. Drop the variable.
function childEnv() {
  var env = {};
  for (var k in process.env) {
    if (k !== 'LD_PRELOAD') env[k] = process.env[k];
  }
  return env;
}

function VpnManager(binaryPath, configsDir, prefixArgs) {
  this._binary = binaryPath;
  this._configsDir = configsDir;
  this._prefixArgs = prefixArgs || [];
}

// The Luna service is started on demand and exits when idle, so connection
// state cannot live in memory: a later status call runs in a fresh process.
// State is kept on disk and validated against /proc on every read.
VpnManager.prototype._readState = function () {
  var pid;
  try {
    pid = parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
  } catch (e) {
    return null;
  }
  if (!pid || !fs.existsSync('/proc/' + pid)) return null;

  return { pid: pid, country: this._readCountry() };
};

VpnManager.prototype._readCountry = function () {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).country || null;
  } catch (e) {
    // Country is cosmetic; a live pid without it still counts as connected.
    return null;
  }
};

VpnManager.prototype._isBlocked = function () {
  return fs.existsSync(KILL_MARKER);
};

// Synchronous on purpose: telling the user "disconnected" while traffic is still
// blocked would leave them offline with no explanation. Returns whether it worked.
VpnManager.prototype._killSwitchOff = function () {
  try {
    var result = spawnSync(KILL_SCRIPT, ['off'], { env: childEnv(), stdio: 'ignore', timeout: 10000 });
    return !!result && result.status === 0;
  } catch (e) {
    return false;
  }
};

VpnManager.prototype._clearState = function (keepCountry) {
  // Both files are routinely absent; removing a missing one is success here.
  if (!keepCountry) {
    try { fs.unlinkSync(STATE_PATH); } catch (e) { /* already gone */ }
  }
  try { fs.unlinkSync(PID_PATH); } catch (e) { /* already gone */ }

  // OpenVPN's --down hook normally drops the resolver override, but it never
  // runs if the process was killed outright. Left behind, it keeps sending
  // every lookup to the VPN provider's DNS over the open internet while the
  // tunnel is gone, so clear it here too. Harmless when already unmounted.
  try {
    spawn('/bin/sh', ['-c', 'mountpoint -q /etc/resolv.conf && umount /etc/resolv.conf'],
      { detached: true, stdio: 'ignore', env: childEnv() }).unref();
  } catch (e) {
    // Best effort: a surviving override degrades privacy, not connectivity.
  }
};

VpnManager.prototype.connect = function (country) {
  if (this._readState() !== null) {
    return { ok: false, error: 'Already connected. Disconnect first.' };
  }

  var configPath = path.join(this._configsDir, country + '.ovpn');
  var authPath = path.join(this._configsDir, '.auth');

  if (!fs.existsSync(configPath)) {
    return { ok: false, error: 'Config not found: ' + configPath };
  }

  // Reconnecting after the tunnel died: the switch only lets the old server
  // through, so a different country's handshake would be blocked.
  if (this._isBlocked() && !this._killSwitchOff()) {
    return { ok: false, error: 'Could not lift the kill switch before reconnecting.' };
  }

  var self = this;
  this._clearState();

  var args = this._prefixArgs
    .concat(['--config', configPath, '--auth-user-pass', authPath])
    .concat(OPENVPN_FLAGS);
  var proc = spawn(this._binary, args, {
    detached: true,
    stdio: 'ignore',
    env: childEnv(),
  });
  // Without this handler an exec failure raises an unhandled 'error' event,
  // which takes the whole Luna service down instead of surfacing the reason.
  proc.on('error', function (e) {
    try {
      fs.appendFileSync(SPAWN_ERR_PATH, new Date().toString() + ' spawn ' +
        self._binary + ' failed: ' + e.message + '\n');
    } catch (e2) {
      // Nowhere left to report this; never let it mask the original failure.
    }
  });
  proc.unref();

  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ country: country }));
  } catch (e) {
    return { ok: false, error: 'Failed to record state: ' + e.message };
  }

  return { ok: true };
};

VpnManager.prototype.disconnect = function () {
  var state = this._readState();
  if (state === null) {
    var wasBlocked = this._isBlocked();
    this._clearState();
    // The tunnel is already gone; if the switch is holding traffic, disconnecting
    // is how the user gets their internet back.
    if (!wasBlocked) return { ok: false, error: 'Not connected.' };
    return this._killSwitchOff()
      ? { ok: true }
      : { ok: false, error: 'Could not lift the kill switch; traffic is still blocked.' };
  }
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (e) {
    this._clearState();
    this._killSwitchOff();
    return { ok: false, error: 'Failed to stop pid ' + state.pid + ': ' + e.message };
  }
  this._clearState();
  return this._killSwitchOff()
    ? { ok: true }
    : { ok: false, error: 'Disconnected, but the kill switch could not be lifted; traffic is still blocked.' };
};

VpnManager.prototype.status = function () {
  var state = this._readState();
  if (state === null) {
    // The kill switch still armed with no tunnel means the tunnel died by itself
    // and traffic is blocked on purpose; report it so the UI can say so.
    var blocked = this._isBlocked();
    var country = blocked ? this._readCountry() : null;
    // A recorded pid that is no longer running means the tunnel died without
    // going through disconnect(); clean up after it so a crashed session does
    // not leave the resolver pointed into a tunnel that no longer exists. While
    // blocked the country is kept, so the UI can name the server that dropped.
    if (fs.existsSync(PID_PATH)) this._clearState(blocked);
    return { connected: false, blocked: blocked, country: country, pid: null };
  }
  return { connected: true, blocked: false, country: state.country, pid: state.pid };
};

VpnManager.prototype.setAutoConnect = function (country) {
  var configPath = path.join(this._configsDir, 'config.json');
  var runnerPath = path.join(this._configsDir, 'autoconnect.js');
  var binary = this._binary;
  var configsDir = this._configsDir;
  var prefix = JSON.stringify(this._prefixArgs);

  fs.writeFileSync(configPath, JSON.stringify({ autoConnect: true, country: country }));

  var runner = [
    '\'use strict\';',
    'var fs = require(\'fs\');',
    'var spawn = require(\'child_process\').spawn;',
    'try {',
    '  var c = JSON.parse(fs.readFileSync(\'' + configPath + '\', \'utf8\'));',
    '  if (!c.autoConnect || !c.country) process.exit(0);',
    '  var ovpn = \'' + configsDir + '/\' + c.country + \'.ovpn\';',
    '  var auth = \'' + configsDir + '/.auth\';',
    '  if (!fs.existsSync(ovpn) || !fs.existsSync(auth)) process.exit(1);',
    '  var args = ' + prefix + '.concat([\'--config\', ovpn,',
    '    \'--auth-user-pass\', auth]).concat(' + JSON.stringify(OPENVPN_FLAGS) + ');',
    '  var env = {};',
    '  for (var k in process.env) { if (k !== \'LD_PRELOAD\') env[k] = process.env[k]; }',
    '  spawn(\'' + binary + '\', args,',
    '    { detached: true, stdio: \'ignore\', env: env }).unref();',
    // Record the country as connect() does, or the app shows a bare
    // "Connected" with no server after the TV boots into a tunnel.
    '  fs.writeFileSync(\'' + STATE_PATH + '\', JSON.stringify({ country: c.country }));',
    '} catch (e) { process.exit(1); }',
  ].join('\n');

  fs.writeFileSync(runnerPath, runner);

  fs.writeFileSync(STARTUP_SCRIPT_PATH, '#!/bin/sh\nnode ' + runnerPath + '\n');
  fs.chmodSync(STARTUP_SCRIPT_PATH, '755');

  return { ok: true };
};

VpnManager.prototype.clearAutoConnect = function () {
  var configPath = path.join(this._configsDir, 'config.json');
  var paths = [configPath, STARTUP_SCRIPT_PATH];
  for (var i = 0; i < paths.length; i++) {
    try { fs.unlinkSync(paths[i]); } catch (e) { /* already gone */ }
  }
  return { ok: true };
};

VpnManager.prototype.getAutoConnect = function () {
  var configPath = path.join(this._configsDir, 'config.json');
  if (!fs.existsSync(configPath)) return { enabled: false, country: null };
  try {
    var c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { enabled: !!c.autoConnect, country: c.country || null };
  } catch (e) {
    return { enabled: false, country: null };
  }
};

module.exports = VpnManager;
