"""``payments.retry_failed_webhooks`` (ARCHITECTURE 16), every 5 minutes.

The providers push to us; when a callback never comes (or came and failed) something stays open.
This sweep closes what can be closed without asking the provider (Payme has no status API for
merchants; Click's status response shape is not confirmed, so neither is called here) and reports
the rest:

1. PENDING payments of a booking that can no longer take them -> CANCELLED;
2. PAID payments whose booking died uncollected ("paid after cancel / expire") -> automatic refund;
3. refunds whose Celery task got lost -> enqueued again;
4. PENDING payments of live bookings that are old -> counted and logged (metric), left alone.

Every item runs in its own transaction; one failing item is logged (ids and exception type only)
and counted, and never stops the rest. All steps are idempotent and batch-limited.
"""

import hashlib
import logging
import uuid
from datetime import datetime, timedelta

from celery.exceptions import SoftTimeLimitExceeded
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from apps.bookings import services as booking_services
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus
from apps.core.exceptions import NotFoundError

from . import conf, lifecycle, refunds, selectors
from .models import Payment, PaymentStatus, RefundReason, RefundStatus

logger = logging.getLogger(__name__)

PAYME_TIMEOUT_REASON = 4  # "cancelled by timeout" in Payme's reason list


def run(now: datetime | None = None) -> dict[str, int]:
    now = now or timezone.now()
    cfg = conf.get_config()
    stats = {
        "orphans_cancelled": 0,
        "auto_refunds": 0,
        "refunds_requeued": 0,
        "payments_repaired": 0,
        "orphan_refund_missing": 0,
        "reservation_mismatch": 0,
        "stale_pending": 0,
        "manual_refunds": 0,
        "failed_refunds": 0,
        "errors": 0,
    }
    _cancel_orphans(now, cfg, stats)
    _refund_orphan_payments(now, cfg, stats)
    _requeue_refunds(now, stats)
    _repair_refunded_payments(now, cfg, stats)
    _recover_missing_refunds(now, cfg, stats)
    _check_reservation_invariant(now, cfg, stats)
    _report_refunds_needing_attention(now, cfg, stats)
    if stats["stale_pending"]:
        logger.info(
            "%d payments are PENDING for a live booking for over %s",
            stats["stale_pending"],
            cfg.stale,
        )
    return stats


def _each(ids, step, stats: dict, counter: str, now: datetime) -> None:
    for item in ids:
        try:
            stats[counter] += bool(step(item, now))
        except SoftTimeLimitExceeded:
            raise  # out of time: stop; the next run continues (all steps are idempotent)
        except Exception as exc:  # noqa: BLE001 - isolation is the point
            stats["errors"] += 1
            logger.error("payments sweep: item %s failed (%s)", item, type(exc).__name__)


def _booking_is_live(booking: Booking, now: datetime, grace) -> bool:
    return (
        booking.status == BookingStatus.PENDING_PAYMENT
        and booking.hold_expires_at is not None
        and booking.hold_expires_at + grace > now
    )


# 1. orphan PENDING payments ------------------------------------------------------------------


def _cancel_orphans(now: datetime, cfg, stats: dict) -> None:
    cutoff = now - cfg.stale
    ids = []
    for payment in selectors.stale_pending_payments(cutoff, cfg.batch_limit).select_related(
        "booking"
    ):
        if _booking_is_live(payment.booking, now, cfg.hold_grace):
            stats["stale_pending"] += 1
        else:
            ids.append(payment.pk)
    _each(ids, _cancel_orphan, stats, "orphans_cancelled", now)


@booking_services.retrying
@transaction.atomic
def _cancel_orphan(payment_id: uuid.UUID, now: datetime) -> bool:
    booking_id = Payment.objects.filter(pk=payment_id).values_list("booking_id", flat=True).first()
    if booking_id is None:
        return False
    booking_services.set_local_timeouts(5)
    _lot, booking = booking_services.lock_lot_and_booking(booking_id)
    payment = Payment.objects.select_for_update(of=("self",)).get(pk=payment_id)
    grace = conf.get_config().hold_grace
    if payment.status != PaymentStatus.PENDING or _booking_is_live(booking, now, grace):
        return False  # paid / cancelled / revived while we were looking
    raw = {**payment.raw_state, "orphan": True}
    if payment.provider == "payme":
        raw["reason"] = PAYME_TIMEOUT_REASON
    lifecycle.set_payment_status(payment, PaymentStatus.CANCELLED, cancelled_at=now, raw_state=raw)
    booking_services.log_booking_event(
        booking,
        reason="payment_cancelled",
        meta={"payment": str(payment.pk), "provider": payment.provider, "orphan": True},
    )
    return True


# 2. paid after the booking died ----------------------------------------------------------------


def _refund_orphan_payments(now: datetime, cfg, stats: dict) -> None:
    ids = selectors.orphan_paid_payment_ids(now, cfg.batch_limit)
    _each(ids, _refund_orphan, stats, "auto_refunds", now)


@booking_services.retrying
@transaction.atomic
def _refund_orphan(payment_id: uuid.UUID, now: datetime) -> bool:
    booking_id = Payment.objects.filter(pk=payment_id).values_list("booking_id", flat=True).first()
    if booking_id is None:
        return False
    booking_services.set_local_timeouts(5)
    try:
        _lot, booking = booking_services.lock_lot_and_booking(booking_id)
    except NotFoundError:
        return False
    payment = Payment.objects.select_for_update(of=("self",)).get(pk=payment_id)
    uncollected = booking.status in (BookingStatus.EXPIRED, BookingStatus.CANCELLED) and (
        booking.paid_amount == 0
    )
    if payment.status != PaymentStatus.PAID or payment.refunded_amount > 0 or not uncollected:
        return False
    return refunds.create_auto_refund(payment, RefundReason.UNPAID_BOOKING, now=now) is not None


# 3. lost refund tasks --------------------------------------------------------------------------


def _requeue_refunds(now: datetime, stats: dict) -> None:
    for refund_id in refunds.refund_ids_to_requeue(now):
        refunds.enqueue_refund(refund_id)
        stats["refunds_requeued"] += 1


# 4. a refund is DONE but its payment still says PAID (the finalising step failed) -----------


def _repair_refunded_payments(now: datetime, cfg, stats: dict) -> None:
    ids = selectors.payments_with_done_refunds(cfg.batch_limit)
    _each(ids, _repair_payment, stats, "payments_repaired", now)


@booking_services.retrying
@transaction.atomic
def _repair_payment(payment_id: uuid.UUID, now: datetime) -> bool:
    booking_id = Payment.objects.filter(pk=payment_id).values_list("booking_id", flat=True).first()
    if booking_id is None:
        return False
    booking_services.set_local_timeouts(conf.get_config().lock_timeout_seconds)
    booking_services.lock_lot_and_booking(booking_id)
    payment = Payment.objects.select_for_update(of=("self",)).get(pk=payment_id)
    return refunds.close_if_fully_refunded(payment, now=now)


# 5. refunds a person must handle ---------------------------------------------------------------


def _report_refunds_needing_attention(now: datetime, cfg, stats: dict) -> None:
    """MANUAL / FAILED refunds older than the threshold: counted and logged at ERROR (ids and
    codes only: no amounts, no personal data) so monitoring can alert. The Step 11 admin list is
    built on ``selectors.refunds_needing_attention``."""
    waiting = selectors.refunds_needing_attention(now - cfg.alert_after, cfg.batch_limit)
    manual = [r for r in waiting if r.status == RefundStatus.MANUAL]
    failed = [r for r in waiting if r.status == RefundStatus.FAILED]
    stats["manual_refunds"], stats["failed_refunds"] = len(manual), len(failed)
    for label, group in (("MANUAL", manual), ("FAILED", failed)):
        if group and _alert_is_new(label, group):
            logger.error(
                "%d refunds %s for over %s: %s",
                len(group),
                label,
                cfg.alert_after,
                ", ".join(str(r.pk) for r in group[:20]),
            )


# 6. a cancelled booking promises a refund but has no refund record ------------------------------


def _recover_missing_refunds(now: datetime, cfg, stats: dict) -> None:
    """Invariant: CANCELLED + refund_amount > 0 => at least one Refund row. If it is ever broken
    (a bug, a hand edit) the promise is put on the books (automatic if a paid payment exists,
    MANUAL otherwise) and ERROR-logged for a person to look at."""
    ids = selectors.cancelled_without_refund_ids(now - cfg.stale, cfg.batch_limit)
    _each(ids, _recover_missing_refund, stats, "orphan_refund_missing", now)


@booking_services.retrying
@transaction.atomic
def _recover_missing_refund(booking_id: uuid.UUID, now: datetime) -> bool:
    booking_services.set_local_timeouts(conf.get_config().lock_timeout_seconds)
    try:
        _lot, booking = booking_services.lock_lot_and_booking(booking_id)
    except NotFoundError:
        return False
    if booking.status != BookingStatus.CANCELLED or booking.refund_amount <= 0:
        return False
    if booking.refunds.exists():
        return False
    logger.error("booking %s: cancelled with a promised refund but no refund record", booking.pk)
    refunds.create_booking_refund(booking, booking.refund_amount)
    return True


ALERT_REPEAT_SECONDS = 24 * 3600


def _alert_is_new(label: str, group) -> bool:
    """The sweep runs every 5 minutes; the same unresolved refunds are re-announced at most once
    a day (a changed set is announced at once). The counters in the stats stay exact."""
    digest = hashlib.sha256(",".join(sorted(str(r.pk) for r in group)).encode()).hexdigest()[:16]
    return cache.add(f"payments:alert:{label}:{digest}", 1, ALERT_REPEAT_SECONDS)


# 7. the reserve invariant -------------------------------------------------------------------

RESERVATION_LOOKBACK = timedelta(days=7)


def _check_reservation_invariant(now: datetime, cfg, stats: dict) -> None:
    """``sum(refunds holding money) == Payment.refunded_amount`` for payments with recent refund
    activity. A difference means money could be refunded twice (or never): ERROR-logged with the
    payment ids and counted, not auto-corrected."""
    ids = selectors.payments_with_reservation_mismatch(now - RESERVATION_LOOKBACK, cfg.batch_limit)
    stats["reservation_mismatch"] = len(ids)
    if ids and _alert_is_new("RESERVATION", [type("Id", (), {"pk": pk}) for pk in ids]):
        logger.error(
            "%d payments have a refund reservation mismatch: %s",
            len(ids),
            ", ".join(str(pk) for pk in ids[:20]),
        )
