'use strict';

var Service = require('webos-service');
var VpnManager = require('./vpn');

// OpenVPN 2.6 (musl, Alpine armv7). That build has [LZO] support, which stock
// static builds lack; NordVPN pushes "comp-lzo no" and a binary without
// compression framing completes the handshake but cannot carry traffic.
//
// It is invoked through its own musl loader rather than a shell wrapper: the
// Luna service context does not exec #! scripts, though it execs ELF files
// fine, so a wrapper script silently does nothing.
// openvpn-launch.sh drops LD_PRELOAD and closes inherited descriptors before
// exec'ing the real binary; see the comments in that script for why both are
// required. It must not be bypassed.
var OPENVPN_BIN = __dirname + '/openvpn-launch.sh';
var CONFIGS_DIR = '/media/developer/vpn';

var vpn = new VpnManager(OPENVPN_BIN, CONFIGS_DIR);
// A Luna service exits once it has been idle this long (the library default is
// 5 s), and every cold start costs well over a second of CPU on this TV: about
// 1.5 s against 0.06 s for a warm call, measured on the device. The app checks
// status every 10 s while it is open, so the default would restart the service
// on every single check. Staying warm longer than that interval avoids it;
// with the app closed the service still exits 30 s later.
var IDLE_SECONDS = 30;

var service = new Service('com.tominem.tvpn.service', undefined, { idleTimer: IDLE_SECONDS });

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
  message.respond({
    returnValue: true,
    connected: result.connected,
    blocked: result.blocked,
    country: result.country,
    pid: result.pid,
  });
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
