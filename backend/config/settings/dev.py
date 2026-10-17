from .base import *  # noqa: F403
from .base import env

# Dev-only key; never reused by prod (prod.py requires SECRET_KEY from the environment).
SECRET_KEY = env("SECRET_KEY", default="dev-only-insecure-key-not-for-production")
DEBUG = True
# Allow text stand-ins for geometry fields when GDAL is missing (never set in base/prod).
GEO_STUB = True
# Only here: manage.py seed_parkings refuses to run anywhere else, even with DEBUG=True.
ALLOW_SEED = True
ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"]
DATABASES = {"default": env.db("DATABASE_URL", default="postgis://habi:habi@localhost:5432/habi")}
REDIS_URL = env("REDIS_URL", default="redis://localhost:6379/0")
CELERY_BROKER_URL = REDIS_URL
CELERY_RESULT_BACKEND = REDIS_URL

# Dev-only signing key (prod requires JWT_SIGNING_KEY from the environment).
SIMPLE_JWT = {  # noqa: F405
    **SIMPLE_JWT,  # noqa: F405
    "SIGNING_KEY": env("JWT_SIGNING_KEY", default="dev-only-insecure-jwt-key-not-for-production"),
}
# Shared cache so DRF throttle counters are consistent across processes.
CACHES = {
    "default": {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": REDIS_URL}
}
HABI_PUBLIC_URL = env("HABI_PUBLIC_URL", default="https://habi.test")
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {"hosts": [REDIS_URL]},
    }
}
