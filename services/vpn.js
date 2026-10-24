'use strict';

var spawn = require('child_process').spawn;
var fs = require('fs');
var path = require('path');

var STARTUP_SCRIPT_PATH = '/var/lib/webosbrew/init.d/99-tvpn';
var LOG_PATH = '/tmp/tvpn-openvpn.log';
var STATE_PATH = '/tmp/tvpn-state.json';
var PID_PATH = '/tmp/tvpn-openvpn.pid';
var SPAWN_ERR_PATH = '/tmp/tvpn-spawn-error.log';

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

  var country = null;
  try {
    country = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).country || null;
  } catch (e) {
    // Country is cosmetic; a live pid without it still counts as connected.
  }

  return { pid: pid, country: country };
};

VpnManager.prototype._clearState = function () {
  // Both files are routinely absent; removing a missing one is success here.
  try { fs.unlinkSync(STATE_PATH); } catch (e) { /* already gone */ }
  try { fs.unlinkSync(PID_PATH); } catch (e) { /* already gone */ }
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

  var self = this;
  this._clearState();

  // --daemon is required, not just convenient: the Luna service exits as soon
  // as it has responded, and a merely detached child does not survive that.
  // OpenVPN daemonizes itself and reports its post-fork pid via --writepid.
  // --log keeps output off the service's pipes, which nothing ever drains.
  var args = this._prefixArgs.concat([
    '--config', configPath,
    '--auth-user-pass', authPath,
    '--log', LOG_PATH,
    '--writepid', PID_PATH,
    '--daemon',
  ]);
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
    this._clearState();
    return { ok: false, error: 'Not connected.' };
  }
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (e) {
    this._clearState();
    return { ok: false, error: 'Failed to stop pid ' + state.pid + ': ' + e.message };
  }
  this._clearState();
  return { ok: true };
};

VpnManager.prototype.status = function () {
  var state = this._readState();
  if (state === null) {
    return { connected: false, country: null, pid: null };
  }
  return { connected: true, country: state.country, pid: state.pid };
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
    '    \'--auth-user-pass\', auth, \'--log\', \'' + LOG_PATH + '\',',
    '    \'--writepid\', \'' + PID_PATH + '\', \'--daemon\']);',
    '  var env = {};',
    '  for (var k in process.env) { if (k !== \'LD_PRELOAD\') env[k] = process.env[k]; }',
    '  spawn(\'' + binary + '\', args,',
    '    { detached: true, stdio: \'ignore\', env: env }).unref();',
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
