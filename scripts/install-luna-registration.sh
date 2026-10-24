#!/bin/sh
# Registers the T-VPN app and service on the Luna bus.
#
# Run this on the TV once after installing the IPK. Dropping services.json
# into the service directory is not sufficient: the bus needs role, permission
# and manifest files under /var/luna-service2-dev, modelled on the ones the
# Homebrew Channel ships. These are written here rather than by hand so the
# registration is reproducible.
#
# The app-level pair is the part that is easy to miss. Without it the service
# answers luna-send from a root shell but every call from the app itself times
# out, because the caller identity WAM uses is "<appId>-<instance>" and nothing
# grants that identity access to the service's group.
set -e

APP=com.tominem.tvpn
SVC=com.tominem.tvpn.service
SVC_DIR=/media/developer/apps/usr/palm/services/$SVC
D=/var/luna-service2-dev

for sub in services.d roles.d api-permissions.d client-permissions.d manifests.d; do
  [ -d "$D/$sub" ] || { echo "missing $D/$sub - is this a rooted webOS TV?" >&2; exit 1; }
done

# How the bus starts the service. Type=dynamic means on demand.
cat > "$D/services.d/$SVC.service" <<EOF
[D-BUS Service]
Name=$SVC
Exec=$SVC_DIR/run-js-service -n $SVC_DIR
Type=dynamic
EOF

# What the service itself may do.
printf '{"appId":"%s","type":"regular","allowedNames":["%s"],"permissions":[{"service":"%s","outbound":["*"]},{"service":"*","inbound":["*"],"outbound":["*"]}]}' \
  "$SVC" "$SVC" "$SVC" > "$D/roles.d/$SVC.service.json"

# What the app may do. WAM registers web apps as "<appId>-<instance>".
printf '{"appId":"%s","type":"regular","allowedNames":["%s-*"],"permissions":[{"service":"%s-*","outbound":["*"]}]}' \
  "$APP" "$APP" "$APP" > "$D/roles.d/$APP.app.json"

# Which groups the service's methods belong to.
printf '{"%s.group":["%s/*"],"ares.webos.cli":["%s/*"]}' \
  "$SVC" "$SVC" "$SVC" > "$D/api-permissions.d/$SVC.api.json"
printf '{"public":["%s/*"]}' "$SVC" > "$D/api-permissions.d/$SVC.api.public.json"

# Which groups each caller identity may reach.
printf '{"%s*":["public"]}' "$SVC" > "$D/client-permissions.d/$SVC.service.json"
printf '{"%s*":["all"]}' "$SVC" > "$D/client-permissions.d/$SVC.root.json"
printf '{"%s-*":["public","%s.group"]}' "$APP" "$SVC" > "$D/client-permissions.d/$APP.app.json"

# Ties the above together for the hub.
printf '{"id":"%s","version":"1.0.0","serviceFiles":["%s/services.d/%s.service"],"roleFiles":["%s/roles.d/%s.service.json","%s/roles.d/%s.app.json"],"apiPermissionFiles":["%s/api-permissions.d/%s.api.json","%s/api-permissions.d/%s.api.public.json"],"clientPermissionFiles":["%s/client-permissions.d/%s.service.json","%s/client-permissions.d/%s.app.json","%s/client-permissions.d/%s.root.json"]}' \
  "$APP" "$D" "$SVC" "$D" "$SVC" "$D" "$APP" "$D" "$SVC" "$D" "$SVC" "$D" "$SVC" "$D" "$APP" "$D" "$SVC" \
  > "$D/manifests.d/$APP.json"

/usr/sbin/ls-control scan-services

echo "Registered $APP and $SVC. Also run ls-control scan-services after any"
echo "reinstall, and if calls to the service ever start hanging."
