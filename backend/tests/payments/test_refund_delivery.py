"""Refund delivery guarantees: at-least-once, fenced results, lost answers, crashed workers,
and the state tables / lint that keep every status write in ``lifecycle``."""

import ast
from datetime import timedelta
from pathlib import Path
from unittest import mock

import pytest
from django.test import override_settings

from apps.core.exceptions import InvalidTransition
from apps.payments import lifecycle, reconcile, refunds, services
from apps.payments.models import Payment, PaymentStatus, RefundStatus
from tests.payments.factories import make_payment, make_refund, payme_id

pytestmark = pytest.mark.django_db


def paid_click(booking, now, ref="555"):
    payment = services.register_transaction(
        booking_id=booking.pk,
        provider="click",
        external_id="910",
        amount=booking.amount,
        now=now,
        provider_ref=ref,
    ).payment
    services.complete_payment(provider="click", external_id="910", now=now)
    payment.refresh_from_db()
    refund = make_refund(payment, key=f"cancel:{booking.pk}")
    Payment.objects.filter(pk=payment.pk).update(refunded_amount=refund.amount)
    return payment, refund


class TestLostAnswers:
    def test_a_repeated_reversal_after_a_lost_answer_is_done_when_the_code_is_configured(
        self, booking, now, transport
    ):
        """Scenario A: Click reversed the payment, our answer was lost (timeout)."""
        payment, refund = paid_click(booking, now)
        transport.push(error="timeout")
        refunds.process_refund(refund.pk, now=now)
        transport.push(data={"error_code": -4, "error_note": "already"})
        with override_settings(CLICK_REVERSAL_DONE_CODES=[-4]):
            outcome = refunds.process_refund(refund.pk, now=now + timedelta(seconds=31))
        refund.refresh_from_db()
        payment.refresh_from_db()
        assert outcome.retry_in is None
        assert refund.status == RefundStatus.DONE and refund.attempts == 2
        assert payment.status == PaymentStatus.REFUNDED

    def test_without_the_configured_code_the_repeat_is_a_visible_failure(
        self, booking, now, transport
    ):
        _, refund = paid_click(booking, now)
        transport.push(error="timeout")
        refunds.process_refund(refund.pk, now=now)
        transport.push(data={"error_code": -4})
        refunds.process_refund(refund.pk, now=now + timedelta(seconds=31))
        refund.refresh_from_db()
        assert refund.status == RefundStatus.FAILED and refund.last_error == "click_error_-4"

    @override_settings(CLICK_STATUS_CHECK=True, CLICK_STATUS_REVERSED_VALUES=[-1])
    def test_status_is_checked_before_a_resend_when_enabled(self, booking, now, transport):
        _, refund = paid_click(booking, now)
        transport.push(error="timeout")  # attempt 1: DELETE, answer lost
        refunds.process_refund(refund.pk, now=now)
        transport.push(data={"payment_status": -1})  # attempt 2: the status check
        refunds.process_refund(refund.pk, now=now + timedelta(seconds=31))
        refund.refresh_from_db()
        assert refund.status == RefundStatus.DONE
        assert [c["method"] for c in transport.calls] == ["DELETE", "GET"]  # no second DELETE

    @override_settings(CLICK_STATUS_CHECK=True, CLICK_STATUS_REVERSED_VALUES=[-1])
    def test_status_check_failure_falls_back_to_resending(self, booking, now, transport):
        _, refund = paid_click(booking, now)
        transport.push(error="timeout")
        refunds.process_refund(refund.pk, now=now)
        transport.push(error="timeout")  # the status check itself fails
        refunds.process_refund(refund.pk, now=now + timedelta(seconds=31))  # DELETE succeeds
        refund.refresh_from_db()
        assert refund.status == RefundStatus.DONE
        assert [c["method"] for c in transport.calls] == ["DELETE", "GET", "DELETE"]

    @override_settings(CLICK_STATUS_CHECK=True, CLICK_STATUS_REVERSED_VALUES=[-1])
    def test_a_payment_that_is_not_reversed_is_resent(self, booking, now, transport):
        _, refund = paid_click(booking, now)
        transport.push(error="timeout")
        refunds.process_refund(refund.pk, now=now)
        transport.push(data={"payment_status": 2})
        refunds.process_refund(refund.pk, now=now + timedelta(seconds=31))
        assert [c["method"] for c in transport.calls] == ["DELETE", "GET", "DELETE"]


class TestCrashedWorker:
    def test_a_claim_that_never_finished_is_taken_over_after_the_lease(
        self, booking, now, transport
    ):
        """Scenario B: the worker died after claiming (or after the provider acted)."""
        _, refund = paid_click(booking, now)
        assert lifecycle.claim_refund(refund.pk, now=now, lease=refunds.CLAIM_LEASE) == 1
        assert refunds.process_refund(refund.pk, now=now + timedelta(minutes=1)).retry_in is None
        assert transport.calls == []  # lease still running: not sent
        later = now + refunds.CLAIM_LEASE + timedelta(seconds=1)
        refunds.process_refund(refund.pk, now=later)
        refund.refresh_from_db()
        assert refund.status == RefundStatus.DONE and refund.attempts == 2
        assert len(transport.calls) == 1

    def test_a_failing_finalise_does_not_lose_the_result(self, booking, now, transport):
        payment, refund = paid_click(booking, now)
        with mock.patch.object(refunds, "_finalise", side_effect=RuntimeError("lot busy")):
            refunds.process_refund(refund.pk, now=now)
        refund.refresh_from_db()
        payment.refresh_from_db()
        assert refund.status == RefundStatus.DONE  # the fact is stored
        assert payment.status == PaymentStatus.PAID  # the side effect is repaired by the sweep
        reconcile.run(now=now)
        payment.refresh_from_db()
        assert payment.status == PaymentStatus.REFUNDED

    def test_two_workers_cannot_both_claim_a_live_refund(self, booking, now):
        _, refund = paid_click(booking, now)
        first = lifecycle.claim_refund(refund.pk, now=now, lease=refunds.CLAIM_LEASE)
        second = lifecycle.claim_refund(refund.pk, now=now, lease=refunds.CLAIM_LEASE)
        assert (first, second) == (1, None)


class TestFencing:
    def test_a_late_result_of_an_abandoned_attempt_is_discarded(self, booking, now):
        _, refund = paid_click(booking, now)
        lease = refunds.CLAIM_LEASE
        assert lifecycle.claim_refund(refund.pk, now=now, lease=lease) == 1
        later = now + lease + timedelta(seconds=1)
        assert lifecycle.claim_refund(refund.pk, now=later, lease=lease) == 2
        assert not lifecycle.finish_refund_attempt(
            refund.pk, 1, to=RefundStatus.FAILED, now=later, last_error="timeout"
        )
        refund.refresh_from_db()
        assert refund.status == RefundStatus.SENT and refund.attempts == 2
        assert lifecycle.finish_refund_attempt(refund.pk, 2, to=RefundStatus.DONE, now=later)
        refund.refresh_from_db()
        assert refund.status == RefundStatus.DONE

    def test_a_refund_settled_by_the_provider_is_not_reopened_by_a_late_failure(self, booking, now):
        payment, refund = paid_click(booking, now)
        lifecycle.claim_refund(refund.pk, now=now, lease=refunds.CLAIM_LEASE)
        refunds.settle_by_provider(payment, booking, now=now)
        assert not lifecycle.finish_refund_attempt(
            refund.pk, 1, to=RefundStatus.FAILED, now=now, last_error="timeout"
        )
        assert not lifecycle.finish_refund_attempt(
            refund.pk, 1, to=RefundStatus.PENDING, now=now, last_error="timeout"
        )
        refund.refresh_from_db()
        assert refund.status == RefundStatus.DONE

    def test_a_stale_retry_result_does_not_schedule_a_retry(self, booking, now, transport):
        _, refund = paid_click(booking, now)
        transport.push(error="timeout")
        real = lifecycle.finish_refund_attempt
        with mock.patch.object(lifecycle, "finish_refund_attempt", return_value=False) as probe:
            outcome = refunds.process_refund(refund.pk, now=now)
        assert probe.called and outcome.retry_in is None
        assert real is not None


class TestTransitionTables:
    def test_payment_cannot_leave_a_final_state(self, booking):
        payment = make_payment(booking, status=PaymentStatus.CANCELLED)
        with pytest.raises(InvalidTransition):
            lifecycle.set_payment_status(payment, PaymentStatus.PAID)

    def test_payment_must_be_paid_before_it_is_refunded(self, booking):
        payment = make_payment(booking)
        with pytest.raises(InvalidTransition):
            lifecycle.set_payment_status(payment, PaymentStatus.REFUNDED)

    @pytest.mark.parametrize("start", [RefundStatus.DONE])
    def test_final_refunds_do_not_move(self, booking, start):
        refund = make_refund(make_payment(booking, status=PaymentStatus.PAID), status=start)
        with pytest.raises(InvalidTransition):
            lifecycle.set_refund_status(refund, RefundStatus.PENDING)

    def test_a_manual_refund_can_become_done_or_failed_but_is_never_sent_again(self, booking):
        refund = make_refund(
            make_payment(booking, status=PaymentStatus.PAID), status=RefundStatus.MANUAL
        )
        with pytest.raises(InvalidTransition):
            lifecycle.set_refund_status(refund, RefundStatus.PENDING)
        lifecycle.set_refund_status(refund, RefundStatus.DONE)

    def test_a_failed_refund_can_be_settled_or_retried_by_an_operator(self, booking):
        payment = make_payment(booking, status=PaymentStatus.PAID)
        for target in (RefundStatus.DONE, RefundStatus.PENDING):
            refund = make_refund(payment, status=RefundStatus.FAILED, amount="1")
            lifecycle.set_refund_status(refund, target)

    def test_late_pending_write_cannot_resurrect_a_finished_refund(self, booking, now):
        refund = make_refund(
            make_payment(booking, status=PaymentStatus.PAID), status=RefundStatus.DONE
        )
        assert not lifecycle.finish_refund_attempt(refund.pk, 0, to=RefundStatus.DONE, now=now)

    def test_unused_factory_helper(self):
        assert payme_id()


APPS = Path(__file__).resolve().parents[2] / "apps"
PAYMENTS = APPS / "payments"
ALLOWED = {"lifecycle.py", "models.py"}
MODELS = {"Payment", "Refund"}
CREATORS = {"create", "get_or_create", "update_or_create", "bulk_create"}


def _is_status_kw(node: ast.Call) -> bool:
    return any(keyword.arg in ("status", None) for keyword in node.keywords)  # None = **kwargs


def _names_status(node: ast.AST) -> bool:
    return any(isinstance(n, ast.Constant) and n.value == "status" for n in ast.walk(node))


def _payments_violations(path: Path) -> list[str]:
    found = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        where = f"{path.name}:{getattr(node, 'lineno', 0)}"
        targets = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AugAssign | ast.AnnAssign):
            targets = [node.target]
        if any(isinstance(t, ast.Attribute) and t.attr == "status" for t in targets):
            found.append(f"{where} assigns .status")
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
        if name == "setattr" and len(node.args) > 1 and _names_status(node.args[1]):
            found.append(f"{where} setattr(..., 'status')")
        elif name == "bulk_update":
            found.append(f"{where} bulk_update")
        elif name == "update" and _is_status_kw(node):
            found.append(f"{where} update(status=/**kwargs)")
        elif name == "save" and any(
            k.arg == "update_fields" and _names_status(k.value) for k in node.keywords
        ):
            found.append(f"{where} save(update_fields=[..'status'..])")
        elif name in MODELS and _is_status_kw(node):  # Refund(status=...)
            found.append(f"{where} {name}(status=...)")
        elif name in CREATORS and _is_status_kw(node) and _on_payment_model(func):
            found.append(f"{where} {name}(status=...)")
    return found


def _on_payment_model(func: ast.AST) -> bool:
    """``Payment.objects.create`` / ``Refund.objects.create`` (the manager chain)."""
    value = getattr(func, "value", None)
    value = getattr(value, "value", None)
    return isinstance(value, ast.Name) and value.id in MODELS


def _other_apps_violations(path: Path) -> list[str]:
    """Outside the payments app: no way to reach the Payment / Refund models at all (import of
    the models module, a model name, ``get_model('payments', ...)``, ``import_module``)."""
    found = []
    where = f"{path.parent.name}/{path.name}"
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        line = getattr(node, "lineno", 0)
        if isinstance(node, ast.ImportFrom):
            module = node.module or ""
            names = {alias.name for alias in node.names}
            if module.endswith("payments.models") and (names & MODELS or "*" in names):
                found.append(f"{where}:{line} imports a payments model")
            if module in ("apps.payments", "payments") and "models" in names:
                found.append(f"{where}:{line} imports payments.models")
        elif isinstance(node, ast.Import):
            if any(alias.name.endswith("payments.models") for alias in node.names):
                found.append(f"{where}:{line} imports payments.models")
        elif isinstance(node, ast.Call):
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            strings = [a.value for a in node.args if isinstance(a, ast.Constant)]
            if name == "get_model" and any(
                isinstance(s, str) and s.split(".")[0] == "payments" for s in strings
            ):
                found.append(f"{where}:{line} get_model('payments', ...)")
            if name == "import_module" and any(
                isinstance(s, str) and s.endswith("payments.models") for s in strings
            ):
                found.append(f"{where}:{line} import_module(payments.models)")
            if name == "getattr" and any(s in MODELS for s in strings if isinstance(s, str)):
                found.append(f"{where}:{line} getattr(..., 'Payment'/'Refund')")
    return found


def test_only_lifecycle_writes_payment_and_refund_status():
    """Like Booking.status and services.py: one module owns the transition tables."""
    offenders = []
    for path in PAYMENTS.rglob("*.py"):
        if "migrations" in path.parts or path.name in ALLOWED:
            continue
        offenders += _payments_violations(path)
    for path in APPS.rglob("*.py"):
        if PAYMENTS not in path.parents and "migrations" not in path.parts:
            offenders += _other_apps_violations(path)
    assert offenders == []


@pytest.mark.parametrize(
    "source",
    [
        "payment.status = 'PAID'",
        "refund.status += 'x'",
        "setattr(refund, 'status', 'DONE')",
        "Refund.objects.filter().update(status='DONE')",
        "Refund.objects.filter().update(**fields)",
        "Refund.objects.bulk_update(rows, ['status'])",
        "refund.save(update_fields=['status'])",
        "Refund.objects.create(status='DONE')",
        "Payment(status='PAID')",
    ],
)
def test_the_lint_catches_each_way_of_writing_a_status(tmp_path, source):
    sample = tmp_path / "bad.py"
    sample.write_text(source + chr(10))
    assert _payments_violations(sample), source


@pytest.mark.parametrize(
    "source",
    [
        "from apps.payments.models import Refund",
        "from apps.payments.models import *",
        "from apps.payments import models",
        "import apps.payments.models",
        "import apps.payments.models as pm",
        "apps.get_model('payments', 'Refund')",
        "django_apps.get_model('payments.Payment')",
        "importlib.import_module('apps.payments.models')",
        "getattr(module, 'Refund')",
    ],
)
def test_the_lint_catches_every_way_of_reaching_the_models_from_other_apps(tmp_path, source):
    sample = tmp_path / "bad.py"
    sample.write_text(source + chr(10))
    assert _other_apps_violations(sample), source


@pytest.mark.parametrize(
    "source",
    [
        "from apps.payments.models import PaymentProvider",
        "from apps.payments.checkout import payment_url_for",
        "apps.get_model('bookings', 'Booking')",
    ],
)
def test_the_lint_allows_the_public_surface(tmp_path, source):
    sample = tmp_path / "ok.py"
    sample.write_text(source + chr(10))
    assert _other_apps_violations(sample) == []
