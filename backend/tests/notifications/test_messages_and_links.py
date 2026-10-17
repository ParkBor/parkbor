"""Templates (3 languages, complete, no personal data) and deep / universal links."""

import re
import string
import uuid
from decimal import Decimal

import pytest
from django.core.exceptions import ImproperlyConfigured

from apps.notifications import links, messages
from apps.notifications.events import CRITICAL_EVENTS, EVENTS

LANGUAGES = ("uz", "ru", "en")


def placeholders(template: str) -> set[str]:
    return {name for _, name, _, _ in string.Formatter().parse(template) if name}


@pytest.mark.parametrize("event", sorted(EVENTS))
def test_every_event_has_title_and_body_in_all_languages(event):
    for language in LANGUAGES:
        entry = messages.TEMPLATES[event][language]
        assert entry["title"].strip() and entry["body"].strip()


@pytest.mark.parametrize("event", sorted(EVENTS))
def test_languages_use_the_same_placeholders(event):
    sets = {
        language: placeholders(messages.TEMPLATES[event][language]["title"])
        | placeholders(messages.TEMPLATES[event][language]["body"])
        for language in LANGUAGES
    }
    assert sets["uz"] == sets["ru"] == sets["en"]


def test_no_template_covers_an_unknown_event():
    assert set(messages.TEMPLATES) == set(EVENTS)


def test_critical_events_are_a_subset_of_events():
    assert CRITICAL_EVENTS <= EVENTS


@pytest.mark.parametrize("event", sorted(EVENTS))
@pytest.mark.parametrize("language", LANGUAGES)
def test_rendering_fills_everything_and_leaves_no_braces(event, language):
    message = messages.render(event, language, {"slot": "A-12", "amount": Decimal("12500.00")})
    assert "{" not in message.title + message.body
    assert "}" not in message.title + message.body


def test_slot_and_amount_are_inserted():
    reassigned = messages.render("slot_reassigned", "en", {"slot": "B-7"})
    assert "B-7" in reassigned.body
    refund = messages.render("refund_done", "en", {"amount": Decimal("12500.00")})
    assert "12 500" in refund.body


def test_amount_is_grouped_and_has_no_decimals_for_whole_sums():
    assert messages.format_amount(Decimal("1234567.00")) == "1 234 567"
    assert messages.format_amount(Decimal("0.50")) == "0.50"


def test_unknown_language_falls_back_to_uzbek():
    assert messages.render("no_show", "xx", {}) == messages.render("no_show", "uz", {})


def test_unknown_event_is_an_error():
    with pytest.raises(KeyError):
        messages.render("nope", "uz", {})


def test_a_missing_context_value_does_not_crash_rendering():
    message = messages.render("slot_reassigned", "en", {})
    assert "{" not in message.body


def test_context_cannot_inject_format_fields():
    message = messages.render("slot_reassigned", "en", {"slot": "{amount}{0}"})
    assert "{amount}{0}" in message.body  # inserted literally, not interpreted


def test_manual_refund_text_promises_one_to_three_working_days():
    assert "1–3" in messages.render("refund_manual", "uz", {}).body
    assert "1–3" in messages.render("refund_manual", "ru", {}).body
    assert "1–3" in messages.render("refund_manual", "en", {}).body


@pytest.mark.parametrize("event", sorted(EVENTS))
@pytest.mark.parametrize("language", LANGUAGES)
def test_no_template_mentions_personal_data(event, language):
    entry = messages.TEMPLATES[event][language]
    text = (entry["title"] + " " + entry["body"]).lower()
    for forbidden in ("{plate}", "{phone}", "{name}", "{first_name}", "{username}"):
        assert forbidden not in text
    assert not re.search(r"\d{2}\s?[a-z]\s?\d{3}", text)  # no plate-looking text


def test_open_button_label_exists_in_every_language():
    for language in LANGUAGES:
        assert messages.OPEN_BUTTON[language].strip()


# --- links ---------------------------------------------------------------------------------


def test_deep_link_uses_the_app_scheme():
    booking_id = uuid.uuid4()
    assert links.booking_deep_link(booking_id) == f"habi://booking/{booking_id}"


def test_universal_link_is_https_on_the_public_host(settings):
    settings.HABI_PUBLIC_URL = "https://habi.uz/"
    booking_id = uuid.uuid4()
    assert links.booking_universal_link(booking_id) == f"https://habi.uz/b/{booking_id}"


def test_universal_link_is_omitted_without_a_public_url(settings):
    settings.HABI_PUBLIC_URL = ""
    assert links.booking_universal_link(uuid.uuid4()) is None


def test_links_only_accept_real_uuids():
    for bad in ("../x", "1; drop", "", None, "12345"):
        with pytest.raises(ValueError):
            links.booking_deep_link(bad)
        with pytest.raises(ValueError):
            links.booking_universal_link(bad)


@pytest.mark.parametrize(
    "good", ["https://habi.uz", "https://habi.uz/", "https://app.habi.uz:8443"]
)
def test_production_url_accepts_https(good):
    assert links.validate_public_url(good) == good.rstrip("/")


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "http://habi.uz",
        "habi.uz",
        "https://",
        "ftp://habi.uz",
        "https://habi.uz/?a=1",
        "https://habi.uz/#x",
    ],
)
def test_production_url_rejects_everything_else(bad):
    with pytest.raises(ImproperlyConfigured):
        links.validate_public_url(bad)
