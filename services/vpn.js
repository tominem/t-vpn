'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Manages a single OpenVPN process lifecycle.
 *
 * @param {string} binaryPath  - Absolute path to the openvpn binary on the TV.
 * @param {string} configsDir  - Directory containing <country>.ovpn files and .auth.
 */
class VpnManager {
  constructor(binaryPath, configsDir) {
    this._binary = binaryPath;
    this._configsDir = configsDir;
    this._process = null;
    this._country = null;
  }

  /**
   * Starts an OpenVPN connection for the given country code.
   * @param {string} country - Two-letter country code matching a <country>.ovpn file.
   * @returns {{ ok: boolean, error?: string }}
   */
  connect(country) {
    if (this._process !== null) {
      return { ok: false, error: 'Already connected. Disconnect first.' };
    }

    const configPath = path.join(this._configsDir, `${country}.ovpn`);
    const authPath = path.join(this._configsDir, '.auth');

    if (!fs.existsSync(configPath)) {
      return { ok: false, error: `Config not found: ${configPath}` };
    }

    const args = ['--config', configPath, '--auth-user-pass', authPath];
    const proc = spawn(this._binary, args, { detached: false });

    proc.on('exit', () => {
      this._process = null;
      this._country = null;
    });

    this._process = proc;
    this._country = country;
    return { ok: true };
  }

  /**
   * Terminates the running OpenVPN process.
   * @returns {{ ok: boolean, error?: string }}
   */
  disconnect() {
    if (this._process === null) {
      return { ok: false, error: 'Not connected.' };
    }
    this._process.kill('SIGTERM');
    this._process = null;
    this._country = null;
    return { ok: true };
  }

  /**
   * Returns current connection status.
   * @returns {{ connected: boolean, country: string|null, pid: number|null }}
   */
  status() {
    if (this._process === null) {
      return { connected: false, country: null, pid: null };
    }
    return { connected: true, country: this._country, pid: this._process.pid };
  }

  /**
   * Persists auto-connect setting and installs a boot-time startup script via
   * Homebrew Channel's init.d mechanism (/var/lib/webosbrew/init.d/).
   * @param {string} country
   * @returns {{ ok: boolean }}
   */
  setAutoConnect(country) {
    const configPath = path.join(this._configsDir, 'config.json');
    const runnerPath = path.join(this._configsDir, 'autoconnect.js');

    fs.writeFileSync(configPath, JSON.stringify({ autoConnect: true, country }));

    // Node.js runner executed at boot — reads config and spawns openvpn
    const runner = [
      '\'use strict\';',
      'const fs = require(\'fs\');',
      'const { spawn } = require(\'child_process\');',
      'try {',
      `  const c = JSON.parse(fs.readFileSync('${configPath}', 'utf8'));`,
      '  if (!c.autoConnect || !c.country) process.exit(0);',
      `  const ovpn = '${this._configsDir}/' + c.country + '.ovpn';`,
      `  const auth = '${this._configsDir}/.auth';`,
      '  if (!fs.existsSync(ovpn) || !fs.existsSync(auth)) process.exit(1);',
      `  spawn('${this._binary}', ['--config', ovpn, '--auth-user-pass', auth, '--daemon'],`,
      '    { detached: true, stdio: \'ignore\' }).unref();',
      '} catch (e) { process.exit(1); }',
    ].join('\n');

    fs.writeFileSync(runnerPath, runner);

    const startupScript = `#!/bin/sh\nnode ${runnerPath}\n`;
    fs.writeFileSync(STARTUP_SCRIPT_PATH, startupScript);
    fs.chmodSync(STARTUP_SCRIPT_PATH, '755');

    return { ok: true };
  }

  /**
   * Removes auto-connect config and boot startup script.
   * @returns {{ ok: boolean }}
   */
  clearAutoConnect() {
    const configPath = path.join(this._configsDir, 'config.json');
    for (const p of [configPath, STARTUP_SCRIPT_PATH]) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
    return { ok: true };
  }

  /**
   * Returns the stored auto-connect setting.
   * @returns {{ enabled: boolean, country: string|null }}
   */
  getAutoConnect() {
    const configPath = path.join(this._configsDir, 'config.json');
    if (!fs.existsSync(configPath)) return { enabled: false, country: null };
    try {
      const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { enabled: !!c.autoConnect, country: c.country || null };
    } catch (_) {
      return { enabled: false, country: null };
    }
  }
}

const STARTUP_SCRIPT_PATH = '/var/lib/webosbrew/init.d/99-tvpn';

module.exports = VpnManager;
