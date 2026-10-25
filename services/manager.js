'use strict';

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

// The one place the manager is built, so the Luna service and the boot-time
// auto-connect cannot come to disagree about how a tunnel is started.
module.exports = new VpnManager(OPENVPN_BIN, CONFIGS_DIR);
