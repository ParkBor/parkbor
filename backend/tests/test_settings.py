"""Settings contract tests (security-relevant defaults and prod hardening)."""

import importlib
import os
import sys

import pytest
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.test import Client

PROD_ENV = {
    "SECRET_KEY": "x" * 60,
    "ALLOWED_HOSTS": "api.parkbor.uz",
    "DATABASE_URL": "postgis://u:p@db:5432/habi",
    "REDIS_URL": "redis://redis:6379/0",
    "JWT_SIGNING_KEY": "j" * 64,
    "QR_SIGNING_KEY": "q" * 64,
    "TELEGRAM_BOT_TOKEN": "123456:PROD-TOKEN",
    "TELEGRAM_BOT_USERNAME": "parkbor_bot",
    "TELEGRAM_WEBHOOK_SECRET": "w" * 40,
    "PAYME_MERCHANT_ID": "587f72c72cac0d162c722ae2",
    "PAYME_KEY": "p" * 36,
    "CLICK_SERVICE_ID": "36",
    "CLICK_MERCHANT_ID": "46",
    "CLICK_MERCHANT_USER_ID": "4",
    "CLICK_SECRET_KEY": "c" * 16,
    "HABI_PUBLIC_URL": "https://parkbor.uz",
}
SETTINGS_MODULES = [
    "config.settings.base",
    "config.settings.dev",
    "config.settings.prod",
    "config.settings.test",
]


def _import_fresh(monkeypatch, module, env):
    """Import a settings module from scratch with exactly `env` as configuration."""
    for key in (*PROD_ENV, "CORS_ALLOWED_ORIGINS"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    for name in SETTINGS_MODULES:
        monkeypatch.delitem(sys.modules, name, raising=False)
    return importlib.import_module(module)


def test_base_defines_no_secret_key(monkeypatch):
    base = _import_fresh(monkeypatch, "config.settings.base", {})
    assert not hasattr(base, "SECRET_KEY")


def test_dev_has_its_own_dev_secret_key(monkeypatch):
    dev = _import_fresh(monkeypatch, "config.settings.dev", {})
    assert dev.SECRET_KEY
    assert dev.DEBUG is True


def test_prod_requires_secret_key(monkeypatch):
    env = {k: v for k, v in PROD_ENV.items() if k != "SECRET_KEY"}
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", env)


@pytest.mark.parametrize(
    "missing",
    [
        "DATABASE_URL",
        "REDIS_URL",
        "ALLOWED_HOSTS",
        "JWT_SIGNING_KEY",
        "QR_SIGNING_KEY",
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_BOT_USERNAME",
        "TELEGRAM_WEBHOOK_SECRET",
    ],
)
def test_prod_requires_infrastructure_env(monkeypatch, missing):
    env = {k: v for k, v in PROD_ENV.items() if k != missing}
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", env)


def test_prod_sets_global_database_timeouts(monkeypatch):
    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    options = prod.DATABASES["default"]["OPTIONS"]["options"]
    assert "lock_timeout=10s" in options and "statement_timeout=30s" in options


def test_prod_rejects_a_short_qr_signing_key(monkeypatch):
    with pytest.raises(ImproperlyConfigured, match="QR_SIGNING_KEY"):
        _import_fresh(monkeypatch, "config.settings.prod", {**PROD_ENV, "QR_SIGNING_KEY": "short"})


def test_booking_settings_are_range_checked(monkeypatch):
    monkeypatch.setenv("BOOKING_HOLD_MINUTES", "0")
    with pytest.raises(ImproperlyConfigured, match="BOOKING_HOLD_MINUTES"):
        _import_fresh(monkeypatch, "config.settings.base", {})
    monkeypatch.delenv("BOOKING_HOLD_MINUTES")


def test_prod_security_flags(monkeypatch):
    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    assert prod.DEBUG is False
    assert prod.SECRET_KEY == PROD_ENV["SECRET_KEY"]
    assert prod.SECURE_SSL_REDIRECT is True
    assert prod.SECURE_HSTS_SECONDS >= 31536000
    assert prod.SECURE_HSTS_INCLUDE_SUBDOMAINS is True
    assert prod.SECURE_HSTS_PRELOAD is True
    assert prod.SECURE_PROXY_SSL_HEADER == ("HTTP_X_FORWARDED_PROTO", "https")
    assert prod.REDIS_URL == PROD_ENV["REDIS_URL"]
    assert prod.CELERY_BROKER_URL == PROD_ENV["REDIS_URL"]
    assert prod.CELERY_RESULT_BACKEND == PROD_ENV["REDIS_URL"]


def test_prod_does_not_use_dev_or_test_secret(monkeypatch):
    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    assert "insecure" not in prod.SECRET_KEY


def test_drf_defaults_are_closed():
    drf = settings.REST_FRAMEWORK
    assert drf["DEFAULT_PERMISSION_CLASSES"] == ["rest_framework.permissions.IsAuthenticated"]


def test_clickjacking_protection_enabled():
    assert "django.middleware.clickjacking.XFrameOptionsMiddleware" in settings.MIDDLEWARE
    response = Client().get("/api/docs/")
    assert response["X-Frame-Options"] == "DENY"


def test_celery_reliability_settings():
    assert settings.CELERY_TASK_ACKS_LATE is True
    assert settings.CELERY_TASK_TIME_LIMIT > settings.CELERY_TASK_SOFT_TIME_LIMIT > 0
    assert settings.CELERY_RESULT_BACKEND


def test_celery_defaults_to_prod_settings(monkeypatch):
    monkeypatch.delenv("DJANGO_SETTINGS_MODULE", raising=False)
    monkeypatch.delitem(sys.modules, "config.celery", raising=False)
    importlib.import_module("config.celery")
    assert os.environ["DJANGO_SETTINGS_MODULE"] == "config.settings.prod"


def test_prod_trusts_exactly_one_proxy_by_default(monkeypatch):
    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    assert prod.REST_FRAMEWORK["NUM_PROXIES"] == 1
    assert prod.SIMPLE_JWT["SIGNING_KEY"] != prod.SECRET_KEY


def test_base_cannot_sign_tokens_without_env_key(monkeypatch):
    base = _import_fresh(monkeypatch, "config.settings.base", {})
    assert "SIGNING_KEY" not in base.SIMPLE_JWT


def test_prod_serves_json_only_and_no_options_metadata(monkeypatch):
    from rest_framework.renderers import JSONRenderer

    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    renderers = prod.REST_FRAMEWORK["DEFAULT_RENDERER_CLASSES"]
    assert renderers == ["rest_framework.renderers.JSONRenderer"]
    assert "BrowsableAPIRenderer" not in str(renderers)
    assert JSONRenderer.format == "json"
    assert prod.REST_FRAMEWORK["DEFAULT_METADATA_CLASS"] is None


def test_prod_initialises_sentry_only_with_dsn(monkeypatch):
    calls = []
    import config.sentry as sentry

    monkeypatch.setattr(sentry, "init_sentry", lambda dsn: calls.append(dsn) or bool(dsn))
    _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    assert calls == [""]


def test_prod_forces_the_postgis_engine(monkeypatch):
    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    assert prod.DATABASES["default"]["ENGINE"] == "django.contrib.gis.db.backends.postgis"


@pytest.mark.parametrize("scheme", ["postgres", "sqlite", "mysql"])
def test_prod_refuses_a_non_postgis_database(monkeypatch, scheme):
    url = "sqlite:///db.sqlite3" if scheme == "sqlite" else f"{scheme}://u:p@db:5432/habi"
    with pytest.raises(ImproperlyConfigured, match="PostGIS"):
        _import_fresh(monkeypatch, "config.settings.prod", {**PROD_ENV, "DATABASE_URL": url})


def test_osrm_url_must_be_http_or_https(monkeypatch):
    with pytest.raises(ImproperlyConfigured, match="OSRM_URL"):
        _import_fresh(monkeypatch, "config.settings.base", {"OSRM_URL": "ftp://osrm:5000"})
    base = _import_fresh(
        monkeypatch, "config.settings.base", {"OSRM_URL": "https://osrm.parkbor.uz"}
    )
    assert base.OSRM_URL == "https://osrm.parkbor.uz"


def test_prod_requires_a_public_url(monkeypatch):
    env = {k: v for k, v in PROD_ENV.items() if k != "HABI_PUBLIC_URL"}
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", env)


@pytest.mark.parametrize("bad", ["http://parkbor.uz", "parkbor.uz", "https://parkbor.uz/?x=1"])
def test_prod_public_url_must_be_https(monkeypatch, bad):
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", {**PROD_ENV, "HABI_PUBLIC_URL": bad})


def test_prod_public_url_loses_its_trailing_slash(monkeypatch):
    prod = _import_fresh(
        monkeypatch, "config.settings.prod", {**PROD_ENV, "HABI_PUBLIC_URL": "https://parkbor.uz/"}
    )
    assert prod.HABI_PUBLIC_URL == "https://parkbor.uz"


def test_prod_uses_the_redis_channel_layer_with_bounded_timeouts(monkeypatch):
    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    layer = prod.CHANNEL_LAYERS["default"]
    assert layer["BACKEND"] == "channels_redis.core.RedisChannelLayer"
    config = layer["CONFIG"]
    assert config["hosts"] == [
        {
            "address": "redis://redis:6379/1",
            "socket_timeout": 10,  # above channels_redis' 5 s blocking receive
            "socket_connect_timeout": 2,
        }
    ]
    assert (config["prefix"], config["expiry"], config["capacity"]) == ("habi", 10, 1000)
    assert config["group_expiry"] == 86400


def test_ws_max_age_stays_below_the_group_expiry(monkeypatch):
    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    config = prod.CHANNEL_LAYERS["default"]["CONFIG"]
    assert prod.WS_MAX_AGE_SECONDS < config["group_expiry"]


def test_prod_keeps_broker_channels_cache_and_state_in_separate_databases(monkeypatch):
    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    assert prod.CELERY_BROKER_URL.endswith("/0")
    assert prod.CHANNEL_REDIS_URL.endswith("/1")
    assert prod.CACHE_REDIS_URL.endswith("/2")
    assert prod.STATE_REDIS_URL.endswith("/3")
    assert prod.CACHES["default"]["LOCATION"] == prod.CACHE_REDIS_URL


def test_redis_roles_can_be_moved_to_other_servers(monkeypatch):
    env = {**PROD_ENV, "CACHE_REDIS_URL": "redis://cache-host:6379/0"}
    prod = _import_fresh(monkeypatch, "config.settings.prod", env)
    assert prod.CACHES["default"]["LOCATION"] == "redis://cache-host:6379/0"


def test_state_redis_is_what_the_application_client_uses(monkeypatch):
    from apps.core import redis_client

    redis_client.set_redis_client(None)
    client = redis_client.get_redis()
    assert client.connection_pool.connection_kwargs["db"] == 3
    redis_client.set_redis_client(None)


def test_prod_reuses_database_connections_and_health_checks_them(monkeypatch):
    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    assert prod.DATABASES["default"]["CONN_MAX_AGE"] == 60
    assert prod.DATABASES["default"]["CONN_HEALTH_CHECKS"] is True


def test_db_conn_max_age_is_tunable(monkeypatch):
    prod = _import_fresh(monkeypatch, "config.settings.prod", {**PROD_ENV, "DB_CONN_MAX_AGE": "0"})
    assert prod.DATABASES["default"]["CONN_MAX_AGE"] == 0


def test_dev_uses_the_redis_channel_layer(monkeypatch):
    dev = _import_fresh(monkeypatch, "config.settings.dev", {})
    assert dev.CHANNEL_LAYERS["default"]["BACKEND"] == "channels_redis.core.RedisChannelLayer"
    assert dev.CACHES["default"]["LOCATION"].endswith("/2")


def test_celery_queues_publish_policy_and_prefetch():
    assert settings.CELERY_TASK_ROUTES == {
        "realtime.*": {"queue": "realtime"},
        "notifications.*": {"queue": "notify"},
    }
    assert settings.CELERY_TASK_PUBLISH_RETRY_POLICY["max_retries"] == 1
    assert settings.CELERY_WORKER_PREFETCH_MULTIPLIER == 1
    options = settings.CELERY_BROKER_TRANSPORT_OPTIONS
    assert options["socket_timeout"] and options["socket_connect_timeout"]


def test_tests_use_the_in_memory_channel_layer():
    assert settings.CHANNEL_LAYERS["default"]["BACKEND"] == "channels.layers.InMemoryChannelLayer"


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("WS_MAX_GROUPS_PER_CONNECTION", "0"),
        ("WS_MAX_MESSAGE_BYTES", "10"),
        ("WS_MAX_CONNECTIONS_PER_USER", "0"),
        ("WS_MESSAGES_PER_SECOND", "100000"),
    ],
)
def test_realtime_limits_are_range_checked(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.base", {name: value})


def test_asgi_serves_http_and_websocket():
    from config.asgi import application

    assert set(application.application_mapping) == {"http", "websocket"}
