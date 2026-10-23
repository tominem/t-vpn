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
}

module.exports = VpnManager;
