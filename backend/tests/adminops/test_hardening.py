"""Security review follow-ups: PII in free text, masked refund errors, headers, reviews rules."""

import importlib
import re
from pathlib import Path
from unittest import mock

import pytest

from apps.audit.scrub import scrub
from apps.payments.refunds import clean_note
from tests.adminops.conftest import BASE, bearer
from tests.payments.factories import make_payment, make_refund

pytestmark = pytest.mark.django_db


# --- free text: phone, card, e-mail, handle, control characters --------------------------------


@pytest.mark.parametrize(
    "note",
    [
        "call +998 90 123 45 67",
        "card 8600 1234 5678 9012",
        "phone 90.123.45.67 ok",
        "ref 12345 and 67890",  # nine digits spread over the text
        "tel: 9-9-8-9-0-1-2-3-4",
        "٩٩٨٩٠١٢٣٤٥",  # Arabic-Indic digits
        "write to ali@example.com",
        "ask @ali_sales",
        "(@boss) knows",
        "plus +7",
    ],
)
def test_notes_with_personal_data_are_refused(note):
    with pytest.raises(ValueError):
        clean_note(note)


@pytest.mark.parametrize("note", ["", "refunded in Payme cabinet", "ticket 1234", "digits 1234567"])
def test_ordinary_notes_pass(note):
    assert clean_note(note) == note


def test_control_characters_are_stripped_from_notes():
    assert clean_note("bad\x1b[31m note\x00‮") == "bad [31m note"


def test_the_cancel_reason_uses_the_same_rules(admin, world_a, make_bk):
    booking = make_bk(world_a)
    client = bearer(admin)
    for reason in ("mail me a@b.co", "@handle please", "1 2 3 4 5 6 7 8 9"):
        response = client.post(
            f"{BASE}/bookings/{booking.pk}/cancel", {"reason": reason}, format="json"
        )
        assert response.status_code == 400


def test_the_audit_scrubber_removes_control_characters_and_provider_text():
    cleaned = scrub({"after": {"note": "a\x1bb\x00c‮d", "error": "Click said: card 8600 declined"}})
    assert cleaned["after"]["note"] == "a b c d"
    assert cleaned["after"]["error"] == "invalid_error_code"
    assert scrub({"after": {"error": "click_error_-5"}})["after"]["error"] == "click_error_-5"
    assert scrub({"after": {"error": ""}})["after"]["error"] == ""


# --- refund error codes ------------------------------------------------------------------------


@pytest.fixture
def failed_refund(world_a, make_bk):
    payment = make_payment(make_bk(world_a), status="PAID", amount="12000", refunded_amount="12000")
    return make_refund(payment, amount="12000", status="FAILED", last_error="click_error_-5")


def test_owner_learns_that_it_failed_but_not_why(owner_a, admin, failed_refund):
    owner_row = bearer(owner_a).get(f"{BASE}/refunds").data["results"][0]
    admin_row = bearer(admin).get(f"{BASE}/refunds").data["results"][0]
    assert owner_row["last_error"] == "error"
    assert admin_row["last_error"] == "click_error_-5"


def test_a_provider_text_in_last_error_never_reaches_even_an_admin(admin, failed_refund):
    from apps.payments.models import Refund

    Refund.objects.filter(pk=failed_refund.pk).update(last_error="Click: card 8600 1234 declined")
    row = bearer(admin).get(f"{BASE}/refunds").data["results"][0]
    assert row["last_error"] == "unknown_error"


def test_booking_detail_masks_nested_refunds_for_owner(owner_a, admin, failed_refund):
    url = f"{BASE}/bookings/{failed_refund.booking_id}"
    assert bearer(owner_a).get(url).data["refunds"][0]["last_error"] == "error"
    assert bearer(admin).get(url).data["refunds"][0]["last_error"] == "click_error_-5"


# --- headers and history -----------------------------------------------------------------------


def test_admin_responses_are_not_cacheable_and_vary_by_authorization(admin):
    response = bearer(admin).get(f"{BASE}/users")
    assert response["Cache-Control"] == "no-store" and response["Pragma"] == "no-cache"
    assert "Authorization" in response["Vary"]


def test_event_actor_is_a_role_label(admin, world_a, make_bk, driver):
    from apps.bookings.models import BookingEvent

    booking = make_bk(world_a)
    BookingEvent.objects.create(booking=booking, to_status="X", reason="by_driver", actor=driver)
    BookingEvent.objects.create(booking=booking, to_status="X", reason="by_cron")
    BookingEvent.objects.create(
        booking=booking, to_status="X", reason="by_owner", actor=world_a.owner
    )
    events = bearer(admin).get(f"{BASE}/bookings/{booking.pk}").data["events"]
    assert {e["reason"]: e["actor"] for e in events} == {
        "by_driver": "driver", "by_cron": "system", "by_owner": "owner",
    }  # fmt: skip


# --- filters and settings plumbing --------------------------------------------------------------


@pytest.mark.parametrize("rating", ["0", "6", "x"])
def test_review_rating_filter_accepts_only_1_to_5(admin, rating):
    assert bearer(admin).get(f"{BASE}/reviews", {"rating": rating}).status_code == 400


def test_prod_settings_have_connect_and_cache_timeouts():
    source = (
        Path(importlib.import_module("config").__file__).parent / "settings" / "prod.py"
    ).read_text(encoding="utf-8")
    assert re.search(r'"connect_timeout":\s*3', source)
    assert re.search(r'"socket_timeout":\s*2', source) and "socket_connect_timeout" in source


def test_trigram_migration_is_a_noop_off_postgres():
    migration = importlib.import_module("apps.bookings.migrations.0009_plate_trigram_index")
    editor = mock.Mock()
    editor.connection.vendor = "sqlite"
    migration.create_index(None, editor)
    migration.drop_index(None, editor)
    editor.execute.assert_not_called()
    editor.connection.vendor = "postgresql"
    migration.create_index(None, editor)
    assert "gin_trgm_ops" in editor.execute.call_args_list[-1].args[0]
    assert migration.Migration.atomic is False
