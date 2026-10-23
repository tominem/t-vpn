'use strict';

var spawn = require('child_process').spawn;
var fs = require('fs');
var path = require('path');

var STARTUP_SCRIPT_PATH = '/var/lib/webosbrew/init.d/99-tvpn';

function VpnManager(binaryPath, configsDir) {
  this._binary = binaryPath;
  this._configsDir = configsDir;
  this._process = null;
  this._country = null;
}

VpnManager.prototype.connect = function (country) {
  if (this._process !== null) {
    return { ok: false, error: 'Already connected. Disconnect first.' };
  }

  var configPath = path.join(this._configsDir, country + '.ovpn');
  var authPath = path.join(this._configsDir, '.auth');

  if (!fs.existsSync(configPath)) {
    return { ok: false, error: 'Config not found: ' + configPath };
  }

  var self = this;
  var args = ['--config', configPath, '--auth-user-pass', authPath];
  var proc = spawn(this._binary, args, { detached: false });

  proc.on('exit', function () {
    self._process = null;
    self._country = null;
  });

  this._process = proc;
  this._country = country;
  return { ok: true };
};

VpnManager.prototype.disconnect = function () {
  if (this._process === null) {
    return { ok: false, error: 'Not connected.' };
  }
  this._process.kill('SIGTERM');
  this._process = null;
  this._country = null;
  return { ok: true };
};

VpnManager.prototype.status = function () {
  if (this._process === null) {
    return { connected: false, country: null, pid: null };
  }
  return { connected: true, country: this._country, pid: this._process.pid };
};

VpnManager.prototype.setAutoConnect = function (country) {
  var configPath = path.join(this._configsDir, 'config.json');
  var runnerPath = path.join(this._configsDir, 'autoconnect.js');
  var binary = this._binary;
  var configsDir = this._configsDir;

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
    '  spawn(\'' + binary + '\', [\'--config\', ovpn, \'--auth-user-pass\', auth, \'--daemon\'],',
    '    { detached: true, stdio: \'ignore\' }).unref();',
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
    try { fs.unlinkSync(paths[i]); } catch (e) {}
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
