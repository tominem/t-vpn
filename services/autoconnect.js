'use strict';

var fs = require('fs');
var vpn = require('./manager');

// Run by /var/lib/webosbrew/init.d/99-tvpn at every boot, when the user has
// turned auto-connect on. It goes through the same connect() as the app, so the
// tunnel comes up with the DNS hooks and the kill switch of the installed
// version. An earlier design generated a runner holding the binary and flags of
// whichever version wrote it; after an upgrade it kept pointing at files that
// were gone and the TV booted without a VPN, with nothing to say why.
var LOG_PATH = '/tmp/tvpn-autoconnect.log';

function fail(message) {
  try {
    fs.appendFileSync(LOG_PATH, new Date().toString() + ' ' + message + '\n');
  } catch (e) {
    // Nowhere left to report this; the exit status still says it failed.
  }
  process.exit(1);
}

var setting = vpn.getAutoConnect();
if (setting.enabled && setting.country) {
  var result = vpn.connect(setting.country);
  if (!result.ok) fail('auto-connect to ' + setting.country + ' failed: ' + result.error);
}
