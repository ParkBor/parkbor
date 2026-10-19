# PostgreSQL 16 + PostGIS 3.4 for Railway (same image as infra/docker-compose.prod.yml).
# Railway: new service from this repo, Root Directory "/deploy/railway/postgis", attach ONE
# volume mounted at /var/lib/postgresql/data. No public domain, no TCP proxy (private network only).
# Variables: POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD (see docs/RAILWAY.md).
FROM postgis/postgis:16-3.4

# A Railway volume root contains lost+found, which initdb refuses: use a subdirectory.
ENV PGDATA=/var/lib/postgresql/data/pgdata

# Conservative tuning for a small instance (~1 GB RAM). Raise with the plan; keep
# max_connections above (api workers + Celery concurrency + a few spare).
CMD ["postgres", \
     "-c", "max_connections=100", \
     "-c", "shared_buffers=256MB", \
     "-c", "effective_cache_size=768MB", \
     "-c", "log_min_duration_statement=500", \
     "-c", "log_lock_waits=on"]
