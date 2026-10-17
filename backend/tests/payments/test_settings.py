"""Payment settings: prod needs every credential (and long enough ones); sandbox never in prod."""

import pytest
from django.core.exceptions import ImproperlyConfigured

from tests.test_settings import PROD_ENV, _import_fresh

PAYMENT_KEYS = [
    "PAYME_MERCHANT_ID",
    "PAYME_KEY",
    "CLICK_SERVICE_ID",
    "CLICK_MERCHANT_ID",
    "CLICK_MERCHANT_USER_ID",
    "CLICK_SECRET_KEY",
]


@pytest.fixture(autouse=True)
def _clean_payment_env(monkeypatch):
    for key in (
        *PAYMENT_KEYS,
        "PAYMENTS_SANDBOX",
        "PAYMENTS_DEFAULT_PROVIDER",
        "PAYMENTS_PROVIDER_IPS",
        "PAYMENTS_RETURN_URL",
        "PAYMENTS_PAYME_IPS",
        "PAYMENTS_CLICK_IPS",
        "PAYME_CHECKOUT_URL",
        "PAYMENTS_DEFAULT_LANG",
    ):
        monkeypatch.delenv(key, raising=False)


@pytest.mark.parametrize("missing", PAYMENT_KEYS)
def test_prod_requires_every_payment_credential(monkeypatch, missing):
    env = {k: v for k, v in PROD_ENV.items() if k != missing}
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", env)


@pytest.mark.parametrize("key, value", [("PAYME_KEY", "short"), ("CLICK_SECRET_KEY", "tiny")])
def test_prod_rejects_short_secrets(monkeypatch, key, value):
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", {**PROD_ENV, key: value})


def test_prod_rejects_placeholder_credentials(monkeypatch):
    env = {**PROD_ENV, "PAYME_MERCHANT_ID": "replace-me"}
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", env)


def test_prod_refuses_sandbox_mode(monkeypatch):
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", {**PROD_ENV, "PAYMENTS_SANDBOX": "true"})


def test_prod_accepts_a_complete_payment_configuration(monkeypatch):
    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    assert prod.PAYME_KEY == PROD_ENV["PAYME_KEY"]
    assert prod.PAYMENTS_SANDBOX is False
    assert prod.PAYMENTS_DEFAULT_PROVIDER == "payme"


def test_default_provider_must_be_known(monkeypatch):
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.base", {"PAYMENTS_DEFAULT_PROVIDER": "stripe"})


def test_dev_may_run_without_credentials_and_with_sandbox(monkeypatch):
    dev = _import_fresh(monkeypatch, "config.settings.dev", {"PAYMENTS_SANDBOX": "true"})
    assert dev.PAYMENTS_SANDBOX is True
    assert dev.PAYME_KEY == ""


def test_provider_ip_list_is_parsed(monkeypatch):
    monkeypatch.setenv("PAYMENTS_PROVIDER_IPS", "185.234.113.1,10.0.0.0/8")
    base = _import_fresh(monkeypatch, "config.settings.base", {})
    assert base.PAYMENTS_PROVIDER_IPS == ["185.234.113.1", "10.0.0.0/8"]


def test_prod_rejects_a_malformed_ip_allowlist(monkeypatch):
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(
            monkeypatch, "config.settings.prod", {**PROD_ENV, "PAYMENTS_PROVIDER_IPS": "not-an-ip"}
        )


def test_prod_rejects_a_return_url_with_a_semicolon(monkeypatch):
    # the Payme GET checkout format uses ';' as the parameter separator
    env = {**PROD_ENV, "PAYMENTS_RETURN_URL": "https://habi.uz/p?a=1;b=2"}
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", env)


@pytest.mark.parametrize(
    "key, value",
    [
        ("PAYME_KEY", "replace-me-" + "x" * 30),
        ("CLICK_SECRET_KEY", "replace-me-xxxxxxxx"),
        ("PAYME_KEY", " " * 40),
        ("CLICK_SECRET_KEY", " " * 20),
    ],
)
def test_prod_rejects_long_placeholders_and_blank_keys(monkeypatch, key, value):
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", {**PROD_ENV, key: value})


def test_prod_defaults_to_the_published_payme_addresses(monkeypatch):
    prod = _import_fresh(monkeypatch, "config.settings.prod", PROD_ENV)
    assert prod.PAYMENTS_PAYME_IPS[0] == "185.234.113.1"
    assert prod.PAYMENTS_PAYME_IPS[-1] == "185.234.113.15"
    assert len(prod.PAYMENTS_PAYME_IPS) == 15


def test_prod_cannot_run_with_an_empty_payme_allowlist(monkeypatch):
    env = {**PROD_ENV, "PAYMENTS_PAYME_IPS": ""}
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", env)
    ok = _import_fresh(
        monkeypatch, "config.settings.prod", {**env, "PAYMENTS_PROVIDER_IPS": "203.0.113.0/24"}
    )
    assert ok.PAYMENTS_PROVIDER_IPS == ["203.0.113.0/24"]


@pytest.mark.parametrize(
    "url", ["http://habi.uz/back", "ftp://x", "javascript:alert(1)", "habi.uz/back", "//habi.uz"]
)
def test_prod_return_url_must_be_https_or_a_deep_link(monkeypatch, url):
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", {**PROD_ENV, "PAYMENTS_RETURN_URL": url})


@pytest.mark.parametrize("url", ["https://habi.uz/back", "habi://payment-return"])
def test_prod_accepts_https_and_deep_link_return_urls(monkeypatch, url):
    prod = _import_fresh(
        monkeypatch, "config.settings.prod", {**PROD_ENV, "PAYMENTS_RETURN_URL": url}
    )
    assert prod.PAYMENTS_RETURN_URL == url


@pytest.mark.parametrize(
    "url",
    [
        "http://checkout.paycom.uz",
        "https://test.paycom.uz",
        "https://evil.example/pay",
        "https://checkout.paycom.uz.evil.example",
    ],
)
def test_prod_checkout_url_must_be_the_real_https_one(monkeypatch, url):
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.prod", {**PROD_ENV, "PAYME_CHECKOUT_URL": url})


def test_default_language_is_validated(monkeypatch):
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.base", {"PAYMENTS_DEFAULT_LANG": "de"})


@pytest.mark.parametrize("value", ["0", "5", "-4,0", "abc", "-4,1"])
def test_click_reversal_done_codes_must_be_negative_integers(monkeypatch, value):
    with pytest.raises(ImproperlyConfigured):
        _import_fresh(monkeypatch, "config.settings.base", {"CLICK_REVERSAL_DONE_CODES": value})


def test_negative_click_codes_are_accepted(monkeypatch):
    base = _import_fresh(
        monkeypatch, "config.settings.base", {"CLICK_REVERSAL_DONE_CODES": "-4,-9"}
    )
    assert base.CLICK_REVERSAL_DONE_CODES == [-4, -9]
