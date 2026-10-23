'use strict';

var Service = require('webos-service');
var VpnManager = require('./vpn');

var OPENVPN_BIN = '/media/developer/openvpn';
var CONFIGS_DIR = '/media/developer/vpn';

var vpn = new VpnManager(OPENVPN_BIN, CONFIGS_DIR);
var service = new Service('com.tominem.tvpn.service');

service.register('connect', function (message) {
  var country = message.payload.country;
  if (!country || typeof country !== 'string') {
    message.respond({ returnValue: false, error: 'Missing required field: country' });
    return;
  }
  var result = vpn.connect(country.toLowerCase());
  message.respond({ returnValue: result.ok, ok: result.ok, error: result.error || undefined });
});

service.register('disconnect', function (message) {
  var result = vpn.disconnect();
  message.respond({ returnValue: result.ok, ok: result.ok, error: result.error || undefined });
});

service.register('status', function (message) {
  var result = vpn.status();
  message.respond({ returnValue: true, connected: result.connected, country: result.country, pid: result.pid });
});

service.register('setAutoConnect', function (message) {
  var enabled = message.payload.enabled;
  var country = message.payload.country;

  if (enabled === false) {
    var r = vpn.clearAutoConnect();
    message.respond({ returnValue: r.ok, ok: r.ok, error: r.error || undefined });
    return;
  }
  if (!country || typeof country !== 'string') {
    message.respond({ returnValue: false, error: 'Missing required field: country' });
    return;
  }
  var result = vpn.setAutoConnect(country.toLowerCase());
  message.respond({ returnValue: result.ok, ok: result.ok, error: result.error || undefined });
});

service.register('getAutoConnect', function (message) {
  var result = vpn.getAutoConnect();
  message.respond({ returnValue: true, enabled: result.enabled, country: result.country });
});
