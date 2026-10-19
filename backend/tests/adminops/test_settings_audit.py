import uuid
from datetime import timedelta

import pytest
from django.core.cache import cache

from apps.audit.models import AuditLog
from apps.bookings import conf
from apps.bookings.models import BookingSetting
from apps.parking.services import audit
from tests.adminops.conftest import BASE, bearer

pytestmark = pytest.mark.django_db

DEFAULTS = {
    "hold_minutes": 10,
    "no_show_grace_minutes": 20,
    "cancel_full_refund_minutes": 60,
    "cancel_full_percent": 100,
    "cancel_late_percent": 50,
    "cancel_after_start_percent": 0,
}


@pytest.fixture(autouse=True)
def _fresh_overrides():
    conf.invalidate_overrides()
    yield
    conf.invalidate_overrides()


def patch(user, **body):
    return bearer(user).patch(f"{BASE}/settings", body, format="json")


def test_get_returns_the_defaults(admin):
    response = bearer(admin).get(f"{BASE}/settings")
    assert response.status_code == 200 and response.data == DEFAULTS


def test_patch_persists_audits_and_drives_the_booking_config(super_admin):
    response = patch(super_admin, hold_minutes=15, cancel_late_percent=40)
    assert response.status_code == 200
    assert response.data == {**DEFAULTS, "hold_minutes": 15, "cancel_late_percent": 40}
    assert bearer(super_admin).get(f"{BASE}/settings").data["hold_minutes"] == 15
    config = conf.get_config()
    assert config.hold == timedelta(minutes=15) and config.cancel_policy.late_percent == 40
    row = AuditLog.objects.get(action="settings.update")
    assert row.actor_id == super_admin.pk
    assert row.meta["before"] == {"hold_minutes": 10, "cancel_late_percent": 50}
    assert row.meta["after"] == {"hold_minutes": 15, "cancel_late_percent": 40}


def test_unchanged_values_write_nothing(super_admin):
    assert patch(super_admin, hold_minutes=10).status_code == 200
    assert not BookingSetting.objects.exclude(key=conf.LOCK_KEY).exists()
    assert not AuditLog.objects.filter(action="settings.update").exists()


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"hold_minutes": 4},
        {"hold_minutes": 121},
        {"no_show_grace_minutes": 4},
        {"no_show_grace_minutes": 241},
        {"cancel_full_refund_minutes": -1},
        {"cancel_full_percent": 101},
        {"hold_minutes": "ten"},
        {"hold_minutes": 5.5},
        {"unknown": 1},
        {"cancel_late_percent": 80},  # above cancel_full_percent (100) is fine ...
    ][:-1]
    + [
        {"cancel_full_percent": 40},  # ... but full below late (50) is not
        {"cancel_after_start_percent": 60},  # after start above late (50)
    ],
)
def test_invalid_values_and_cross_field_rules_are_400(super_admin, body):
    assert patch(super_admin, **body).status_code == 400
    assert not BookingSetting.objects.exclude(key=conf.LOCK_KEY).exists()


def test_cross_field_rule_uses_the_merged_values(super_admin):
    assert patch(super_admin, cancel_full_percent=40, cancel_late_percent=30).status_code == 200


def test_overrides_fall_back_to_defaults_when_unreadable(monkeypatch):
    from django.db import DatabaseError

    def boom(*args, **kwargs):
        raise DatabaseError("down")

    monkeypatch.setattr(BookingSetting.objects, "values_list", boom)
    assert conf.effective_settings() == DEFAULTS


def test_a_plain_admin_may_read_but_not_change_settings(admin):
    assert patch(admin, hold_minutes=15).status_code == 403
    assert bearer(admin).get(f"{BASE}/settings").status_code == 200
    assert not BookingSetting.objects.exclude(key=conf.LOCK_KEY).exists()


def test_get_reads_the_database_not_a_stale_cache(admin, super_admin):
    assert bearer(admin).get(f"{BASE}/settings").data["hold_minutes"] == 10  # warms the cache
    BookingSetting.objects.create(key="hold_minutes", value=30)  # changed behind the cache's back
    assert bearer(admin).get(f"{BASE}/settings").data["hold_minutes"] == 30


def test_first_update_on_a_fresh_install_creates_the_lock_row(super_admin):
    assert not BookingSetting.objects.exclude(key=conf.LOCK_KEY).exists()
    assert patch(super_admin, hold_minutes=20).status_code == 200
    assert BookingSetting.objects.filter(key=conf.LOCK_KEY).exists()
    assert patch(super_admin, hold_minutes=25).status_code == 200  # the lock row is reused
    assert BookingSetting.objects.filter(key=conf.LOCK_KEY).count() == 1


def test_a_broken_stored_set_is_ignored_by_the_booking_rules():
    BookingSetting.objects.create(key="cancel_full_percent", value=10)  # below late (50): invalid
    cache.delete(conf.OVERRIDES_CACHE_KEY)
    assert conf.get_config().cancel_policy.full_percent == 100  # the environment default


def test_a_dead_cache_does_not_stop_the_booking_rules(monkeypatch):
    def dead(*args, **kwargs):
        raise ConnectionError("cache down")

    monkeypatch.setattr(conf.cache, "get", dead)
    monkeypatch.setattr(conf.cache, "set", dead)
    monkeypatch.setattr(conf.cache, "delete", dead)
    BookingSetting.objects.create(key="hold_minutes", value=33)
    assert conf.get_config().hold == timedelta(minutes=33)  # straight from the database
    conf.invalidate_overrides()  # must not raise


# --- audit log -----------------------------------------------------------------------------------


def test_audit_list_shape_and_filters(admin, driver):
    audit(actor=admin, action="user.block", obj_id=driver.pk, before={"is_active": True},
          after={"is_active": False, "phone": "+998901112233"})  # fmt: skip
    audit(actor=None, action="booking.expire", obj_id="b1", before={}, after={"status": "EXPIRED"})
    client = bearer(admin)
    rows = client.get(f"{BASE}/audit-logs").data["results"]
    assert set(rows[0]) == {
        "id",
        "created_at",
        "actor",
        "action",
        "target_type",
        "target_id",
        "meta",
    }
    blocked = next(r for r in rows if r["action"] == "user.block")
    assert "phone" not in blocked["meta"]["after"]  # scrubbed on write
    assert blocked["meta"]["after"]["_dropped"] == ["phone"]

    def ids(**params):
        return [r["action"] for r in client.get(f"{BASE}/audit-logs", params).data["results"]]

    assert ids(action="user.block") == ["user.block"]
    assert ids(target_type="booking") == ["booking.expire"]
    assert ids(target_id=str(driver.pk)) == ["user.block"]
    assert ids(actor=str(admin.pk)) == ["user.block"]
    assert ids(actor=str(uuid.uuid4())) == []
    assert set(
        ids(**{"from": (AuditLog.objects.first().created_at - timedelta(hours=1)).isoformat()})
    ) == {
        "user.block",
        "booking.expire",
    }
    assert (
        ids(**{"to": (AuditLog.objects.first().created_at - timedelta(hours=1)).isoformat()}) == []
    )
    assert client.get(f"{BASE}/audit-logs", {"actor": "nope"}).status_code == 400


def test_audit_log_is_read_only(admin):
    client = bearer(admin)
    row = AuditLog.objects.create(actor=admin, action="x.y", target_type="x", target_id="1")
    assert client.post(f"{BASE}/audit-logs", {}, format="json").status_code == 405
    assert client.delete(f"{BASE}/audit-logs/{row.pk}").status_code == 404
    assert client.patch(f"{BASE}/audit-logs/{row.pk}", {}, format="json").status_code == 404


def test_audit_list_query_count(admin, django_assert_max_num_queries):
    for index in range(10):
        AuditLog.objects.create(actor=admin, action="x.y", target_type="x", target_id=str(index))
    with django_assert_max_num_queries(4):
        assert bearer(admin).get(f"{BASE}/audit-logs").data["count"] == 10


@pytest.mark.parametrize(
    ("body", "code"),
    [
        ({"cancel_full_percent": 40}, "settings_order_invalid"),
        ({"cancel_after_start_percent": 60}, "settings_order_invalid"),
        ({"hold_minutes": 4}, None),  # a field range: rejected by the serializer first
    ],
)
def test_ordering_rule_has_a_stable_code(super_admin, body, code):
    response = patch(super_admin, **body)
    assert response.status_code == 400
    if code:
        assert response.data["code"] == code and response.data["detail"]


def test_range_rule_in_the_service_has_its_own_code():
    from apps.adminpanel import services
    from apps.core.exceptions import DomainValidationError

    values = {**conf.env_defaults(), "hold_minutes": 1}
    with pytest.raises(DomainValidationError) as caught:
        services.validate_settings(values)
    assert caught.value.detail["code"] == "settings_range_invalid"
