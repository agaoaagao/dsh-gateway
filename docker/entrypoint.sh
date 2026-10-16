#!/bin/sh
#
# Container entrypoint for dsh-gateway.
#
# Its whole job is to turn environment variables into the gateway's flags, and to
# seed the profile when the volume it runs on is empty. Everything after the
# first `--` is passed through untouched, so an operator can still reach any flag
# the gateway supports:  docker run … dsh-gateway --log-level debug

set -eu

DSH_HOME="${DSH_HOME:-/srv/dsh}"
export DSH_HOME
HOME_ROOT="${DSH_GATEWAY_HOME_ROOT:-/srv/users}"
STATE="${DSH_GATEWAY_STATE:-/srv/gateway/state.json}"
PROFILE="${DSH_GATEWAY_PROFILE:-web}"
PORT="${DSH_GATEWAY_PORT:-8080}"
BIND="${DSH_GATEWAY_BIND:-0.0.0.0}"

mkdir -p "$HOME_ROOT" "$(dirname "$STATE")"

# A named volume starts empty, so the profile has to be seeded on the first run.
# This composes the profile from the bundles already inside the image; it does not
# download anything, and it is a no-op afterwards.
if [ ! -f "$DSH_HOME/profiles/$PROFILE/package.json" ]; then
  echo "dsh-gateway: seeding profile '$PROFILE' into $DSH_HOME"
  dsh --profile "$PROFILE" --dump-default-config > /dev/null
fi

set -- node /app/gateway.mjs \
  --spawn \
  --listen "$PORT" \
  --bind "$BIND" \
  --profile "$PROFILE" \
  --template "$DSH_HOME" \
  --home-root "$HOME_ROOT" \
  --state "$STATE" \
  --accounts "${DSH_GATEWAY_ACCOUNTS:-$(dirname "$STATE")/accounts.json}" \
  --admin-password "${DSH_GATEWAY_ADMIN_PASSWORD:-admin12345}" \
  --max-instances "${DSH_GATEWAY_MAX_INSTANCES:-8}" \
  --idle-minutes "${DSH_GATEWAY_IDLE_MINUTES:-30}"

# Extra authorities a browser may use to reach this gateway.
#
# dsh refuses API calls whose Host it does not trust, and it derives that list
# from its own interfaces. Behind a bridge network the browser's Host is the
# host's address, which the container cannot enumerate, so it must be named here
# (e.g. DSH_GATEWAY_TRUSTED_HOSTS=192.168.100.1). Port-less entries match any
# port, so they survive a published-port change.
for host in $(printf '%s' "${DSH_GATEWAY_TRUSTED_HOSTS:-}" | tr ',' ' '); do
  if [ -n "$host" ]; then
    set -- "$@" --trusted-host "$host"
  fi
done

exec "$@"
