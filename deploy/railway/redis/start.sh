#!/bin/sh
# Starts redis-server from environment variables (see Dockerfile). Never prints the password.
set -eu
: "${REDIS_PASSWORD:?REDIS_PASSWORD is required}"

if [ "${REDIS_PERSIST:-yes}" = "yes" ]; then
  set -- --appendonly yes --appendfsync everysec --save "900 1 300 100"
else
  set -- --appendonly no --save ""
fi

# Started as root (a Railway volume is root-owned): fix ownership of /data, then drop to `redis`.
if [ "$(id -u)" = "0" ]; then
  chown redis:redis /data
  set -- su-exec redis redis-server \
    --bind "* -::*" --protected-mode no \
    --requirepass "$REDIS_PASSWORD" \
    --maxmemory "${REDIS_MAXMEMORY:-400mb}" \
    --maxmemory-policy "${REDIS_POLICY:-noeviction}" \
    --dir /data "$@"
else
  set -- redis-server \
    --bind "* -::*" --protected-mode no \
    --requirepass "$REDIS_PASSWORD" \
    --maxmemory "${REDIS_MAXMEMORY:-400mb}" \
    --maxmemory-policy "${REDIS_POLICY:-noeviction}" \
    --dir /data "$@"
fi
# --bind "* -::*": IPv4 and IPv6 (Railway private DNS is IPv6-only in legacy environments).
exec "$@"
