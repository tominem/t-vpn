'use strict';

/**
 * Luna service entry point for T-VPN.
 *
 * Registers three methods on com.tominem.tvpn.service:
 *   connect    { country: string }            -> { ok, error? }
 *   disconnect {}                             -> { ok, error? }
 *   status     {}                             -> { connected, country, pid }
 *
 * The webos-service package is only available on the TV.
 * On dev machines it is absent and this file is never executed directly.
 */

const Service = require('webos-service');
const VpnManager = require('./vpn');

const OPENVPN_BIN = '/media/developer/openvpn';
const CONFIGS_DIR = '/media/developer/vpn';

const vpn = new VpnManager(OPENVPN_BIN, CONFIGS_DIR);
const service = new Service('com.tominem.tvpn.service');

service.register('connect', (message) => {
  const { country } = message.payload;
  if (!country || typeof country !== 'string') {
    message.respond({ returnValue: false, error: 'Missing required field: country' });
    return;
  }
  const result = vpn.connect(country.toLowerCase());
  message.respond({ returnValue: result.ok, ...result });
});

service.register('disconnect', (message) => {
  const result = vpn.disconnect();
  message.respond({ returnValue: result.ok, ...result });
});

service.register('status', (message) => {
  const result = vpn.status();
  message.respond({ returnValue: true, ...result });
});

service.register('setAutoConnect', (message) => {
  const { enabled, country } = message.payload;
  if (enabled === false) {
    const result = vpn.clearAutoConnect();
    message.respond({ returnValue: result.ok, ...result });
    return;
  }
  if (!country || typeof country !== 'string') {
    message.respond({ returnValue: false, error: 'Missing required field: country' });
    return;
  }
  const result = vpn.setAutoConnect(country.toLowerCase());
  message.respond({ returnValue: result.ok, ...result });
});

service.register('getAutoConnect', (message) => {
  const result = vpn.getAutoConnect();
  message.respond({ returnValue: true, ...result });
});
