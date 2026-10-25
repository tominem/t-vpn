# Shared by the scripts that talk to the TV. Source it; do not run it.
#
# The TV's address comes from DHCP and changes, so it is never written in this
# repository. It is taken, in order, from the first argument, from $TV_HOST, or
# from the webos-tv skill's ~/.config/webos-tv/tv.env (which the skill's
# tv-find.sh --save keeps current). The SSH key, user and port come from the
# same file or the environment.
#
#   resolve_tv "$1"      sets TV, KEY, TV_USER_, TV_PORT_; returns 2 if no address
#   tv_ssh <command...>  runs a command on the TV
#   tv_scp <src> <dest>  copies a local file to the TV

resolve_tv() {
  _config=${TV_CONFIG:-$HOME/.config/webos-tv/tv.env}
  if [ -f "$_config" ]; then
    # shellcheck disable=SC1090
    . "$_config"
  fi
  TV=${1:-${TV_HOST:-}}
  KEY=${TV_KEY:-$HOME/.ssh/webos_tv_new}
  TV_USER_=${TV_USER:-root}
  TV_PORT_=${TV_PORT:-22}
  if [ -z "$TV" ]; then
    echo "No TV address: pass it as the first argument, set TV_HOST, or run the" >&2
    echo "webos-tv skill's tv-find.sh --save to write $_config." >&2
    return 2
  fi
}

tv_ssh() {
  ssh -i "$KEY" -p "$TV_PORT_" -o ConnectTimeout=10 -o BatchMode=yes "$TV_USER_@$TV" "$@"
}

tv_scp() {
  scp -q -i "$KEY" -P "$TV_PORT_" -o ConnectTimeout=10 -o BatchMode=yes "$1" "$TV_USER_@$TV:$2"
}
