import uuid
from datetime import timedelta

import pytest

from apps.audit.models import AuditLog
from apps.payments.models import Payment, Refund
from tests.adminops.conftest import BASE, bearer
from tests.payments.factories import make_payment, make_refund

pytestmark = pytest.mark.django_db


@pytest.fixture
def paid(world_a, make_bk):
    booking = make_bk(world_a)
    return make_payment(booking, status="PAID", amount="12000", refunded_amount="12000")


@pytest.fixture
def queued(monkeypatch):
    from apps.payments import tasks

    calls = []
    monkeypatch.setattr(tasks.send_refund, "apply_async", lambda *a, **k: calls.append(a[0][0]))
    return calls


def resolve(user, refund, **body):
    return bearer(user).post(f"{BASE}/refunds/{refund.pk}/resolve", body, format="json")


# --- payments ---------------------------------------------------------------------------------


def test_payment_rows_hide_provider_internals(admin, paid):
    (row,) = bearer(admin).get(f"{BASE}/payments").data["results"]
    assert set(row) == {
        "id", "booking", "provider", "amount", "refunded_amount", "status", "performed_at",
        "cancelled_at", "created_at",
    }  # fmt: skip
    assert str(row["booking"]) == str(paid.booking_id) and row["amount"] == "12000.00"


def test_payment_filters_and_owner_scope(admin, owner_a, world_a, world_b, make_bk):
    mine = make_payment(make_bk(world_a), status="PAID", provider="payme")
    theirs = make_payment(make_bk(world_b), status="PENDING", provider="click")

    def ids(user, **params):
        return {r["id"] for r in bearer(user).get(f"{BASE}/payments", params).data["results"]}

    assert ids(owner_a) == {str(mine.pk)}
    assert ids(admin) == {str(mine.pk), str(theirs.pk)}
    assert ids(admin, status="PENDING") == {str(theirs.pk)}
    assert ids(admin, provider="payme") == {str(mine.pk)}
    assert ids(admin, booking=str(mine.booking_id)) == {str(mine.pk)}
    window = {"from": (mine.created_at - timedelta(minutes=1)).isoformat()}
    assert ids(admin, **window) == {str(mine.pk), str(theirs.pk)}
    assert (
        bearer(owner_a).get(f"{BASE}/payments", {"booking": str(theirs.booking_id)}).status_code
        == 400
    )


def test_payments_are_read_only(admin, paid):
    client = bearer(admin)
    assert client.post(f"{BASE}/payments", {}, format="json").status_code == 405
    assert client.delete(f"{BASE}/payments/{paid.pk}").status_code == 404


# --- refunds ----------------------------------------------------------------------------------


def test_refund_list_shape_and_needs_attention_filter(admin, paid, world_a, make_bk):
    manual = make_refund(paid, amount="1000", status="MANUAL")
    failed = make_refund(paid, amount="1000", status="FAILED", last_error="click_error_-5")
    final = make_refund(paid, amount="1000", status="FAILED", last_error="operator_failed")
    done = make_refund(paid, amount="1000", status="DONE")
    client = bearer(admin)
    everything = client.get(f"{BASE}/refunds").data["results"]
    assert {r["id"] for r in everything} == {str(r.pk) for r in (manual, failed, final, done)}
    assert set(everything[0]) == {
        "id", "payment", "booking", "amount", "status", "reason", "attempts", "last_error",
        "created_at", "updated_at",
    }  # fmt: skip
    attention = client.get(f"{BASE}/refunds", {"needs_attention": "true"}).data["results"]
    assert {r["id"] for r in attention} == {str(manual.pk), str(failed.pk)}
    rest = client.get(f"{BASE}/refunds", {"needs_attention": "false"}).data["results"]
    assert {r["id"] for r in rest} == {str(final.pk), str(done.pk)}
    only = client.get(f"{BASE}/refunds", {"status": "DONE"}).data["results"]
    assert [r["id"] for r in only] == [str(done.pk)]


def test_owner_sees_only_refunds_of_own_lots(owner_a, world_a, world_b, make_bk):
    mine = make_refund(make_payment(make_bk(world_a), status="PAID"), status="MANUAL")
    make_refund(make_payment(make_bk(world_b), status="PAID"), status="MANUAL")
    rows = bearer(owner_a).get(f"{BASE}/refunds").data["results"]
    assert [r["id"] for r in rows] == [str(mine.pk)]


def test_refund_list_query_count(admin, paid, django_assert_max_num_queries):
    for _ in range(5):
        make_refund(paid, amount="100", status="MANUAL")
    with django_assert_max_num_queries(4):
        assert bearer(admin).get(f"{BASE}/refunds").data["count"] == 5


# --- resolve ----------------------------------------------------------------------------------


def test_resolve_done_closes_the_payment_and_audits_with_the_actor(admin, paid):
    refund = make_refund(paid, amount="12000", status="MANUAL")
    response = resolve(admin, refund, outcome="done", note="returned in Payme cabinet")
    assert response.status_code == 200 and response.data["status"] == "DONE"
    paid.refresh_from_db()
    assert paid.status == "REFUNDED"
    row = AuditLog.objects.get(action="refund.resolve")
    assert row.actor_id == admin.pk and row.meta["after"]["outcome"] == "done"


def test_resolve_retry_requeues_a_failed_refund(admin, paid, queued):
    refund = make_refund(
        paid, amount="12000", status="FAILED", last_error="click_error_-5", attempts=3
    )
    response = resolve(admin, refund, outcome="retry", note="")
    assert response.status_code == 200 and response.data["status"] == "PENDING"
    assert response.data["attempts"] == 0 and response.data["last_error"] == ""


def test_resolve_failed_is_final(admin, paid):
    refund = make_refund(paid, amount="12000", status="MANUAL")
    assert resolve(admin, refund, outcome="failed", note="client declined").status_code == 200
    again = resolve(admin, refund, outcome="done", note="")
    assert again.status_code == 409 and again.data["code"] == "invalid_transition"
    assert resolve(admin, refund, outcome="retry", note="").status_code == 409
    paid.refresh_from_db()
    assert paid.refunded_amount == 0


def test_resolve_retry_needs_a_payment(admin, world_a, make_bk):
    booking = make_bk(world_a)
    manual = Refund.objects.create(
        booking=booking, amount=100, status="MANUAL", reason="booking_cancelled",
        idempotency_key="orphan2", last_error="no_paid_payment",
    )  # fmt: skip
    # retry is only for FAILED refunds, and a payment-less refund is MANUAL at best
    response = resolve(admin, manual, outcome="retry", note="")
    assert response.status_code == 409 and response.data["code"] == "invalid_transition"


@pytest.mark.parametrize("status", ["PENDING", "SENT", "DONE"])
def test_refunds_in_flight_or_finished_cannot_be_touched(admin, paid, status):
    refund = make_refund(paid, amount="12000", status=status)
    response = resolve(admin, refund, outcome="done", note="")
    assert response.status_code == 409 and response.data["code"] == "invalid_transition"


def test_reservation_mismatch_is_a_409_and_changes_nothing(admin, paid):
    refund = make_refund(paid, amount="12000", status="MANUAL")
    Payment.objects.filter(pk=paid.pk).update(refunded_amount=5000)  # corrupt the reserve
    response = resolve(admin, refund, outcome="done", note="")
    assert response.status_code == 409 and response.data["code"] == "reservation_mismatch"
    refund.refresh_from_db()
    assert refund.status == "MANUAL"
    assert not AuditLog.objects.filter(action="refund.resolve").exists()


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"outcome": "refund", "note": ""}, "outcome"),
        ({"outcome": "done", "note": "x" * 201}, "note"),
        ({"outcome": "done", "note": "call +998901234567"}, "note"),
        ({"outcome": "done", "note": "card 8600 1234 5678 9012"}, "note"),
        ({"outcome": "done", "note": "ok", "status": "DONE"}, "status"),
        ({"note": "no outcome"}, "outcome"),
    ],
)
def test_resolve_validates_the_body_on_the_server(admin, paid, body, field):
    refund = make_refund(paid, amount="12000", status="MANUAL")
    response = resolve(admin, refund, **body)
    assert response.status_code == 400 and field in response.data
    refund.refresh_from_db()
    assert refund.status == "MANUAL"


def test_resolve_unknown_refund_is_404(admin):
    response = bearer(admin).post(
        f"{BASE}/refunds/{uuid.uuid4()}/resolve", {"outcome": "done"}, format="json"
    )
    assert response.status_code == 404


def test_only_admin_resolves(owner_a, paid):
    refund = make_refund(paid, amount="12000", status="MANUAL")
    assert resolve(owner_a, refund, outcome="done", note="").status_code == 403
