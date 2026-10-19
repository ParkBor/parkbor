# Redis 7.4 for Railway, configured entirely by variables so ONE Dockerfile serves both roles
# (ARCHITECTURE 17, redis_urls.py):
#   service "redis"        REDIS_POLICY=noeviction  REDIS_PERSIST=yes  + volume at /data
#                          (Celery broker db 0, Channels db 1, application state db 3)
#   service "redis-cache"  REDIS_POLICY=allkeys-lru REDIS_PERSIST=no   (no volume; Django cache,
#                          throttling counters; disposable)
# Railway: Root Directory "/deploy/railway/redis". Private network only (no public domain/TCP proxy).
FROM redis:7.4-alpine

ENV REDIS_POLICY=noeviction \
    REDIS_MAXMEMORY=400mb \
    REDIS_PERSIST=yes

# redis:7.4-alpine does not ship su-exec (start.sh needs it to drop root).
RUN apk add --no-cache su-exec

COPY start.sh /usr/local/bin/parkbor-redis-start
RUN chmod 0755 /usr/local/bin/parkbor-redis-start
# start.sh runs as root (Railway volumes are root-owned), chowns /data and drops to `redis`.
CMD ["parkbor-redis-start"]
