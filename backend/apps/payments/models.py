"""Payments (ARCHITECTURE 7, 7.1, 8.1). Money is ``Decimal`` in soums; only the Payme adapter
speaks tiyin. Nothing here stores secrets, signatures, Authorization headers or raw bodies."""

from decimal import Decimal

from django.db import models
from django.db.models import F, Q

from apps.core.models import BaseModel


class PaymentProvider(models.TextChoices):
    PAYME = "payme", "Payme"
    CLICK = "click", "Click"


class PaymentStatus(models.TextChoices):
    CREATED = "CREATED", "Created"  # reserved: a provider transaction is not known yet
    PENDING = "PENDING", "Pending"  # provider transaction exists (Payme state 1 / Click prepared)
    PAID = "PAID", "Paid"
    CANCELLED = "CANCELLED", "Cancelled"  # cancelled before it was performed
    REFUNDED = "REFUNDED", "Refunded"  # fully returned after it was performed (Payme state -2)
    FAILED = "FAILED", "Failed"


class RefundStatus(models.TextChoices):
    PENDING = "PENDING", "Pending"  # waiting for (or between) attempts to reach the provider
    SENT = "SENT", "Sent"  # claimed by a worker: the provider call is in flight (lease)
    DONE = "DONE", "Done"
    FAILED = "FAILED", "Failed"  # permanent: needs a human
    MANUAL = "MANUAL", "Manual"  # the provider has no API for it: operator refunds in a cabinet


class RefundReason(models.TextChoices):
    BOOKING_CANCELLED = "booking_cancelled", "Booking cancelled by the driver"
    UNPAID_BOOKING = "unpaid_booking", "Paid after the booking was cancelled or expired"
    DUPLICATE = "duplicate", "Second payment for an already paid booking"
    PROVIDER = "provider", "Cancelled on the provider side"


class Payment(BaseModel):
    booking = models.ForeignKey(
        "bookings.Booking", on_delete=models.PROTECT, related_name="payments"
    )
    provider = models.CharField(max_length=10, choices=PaymentProvider.choices)
    # The provider's transaction id: Payme `params.id` (24 chars), Click `click_trans_id`.
    external_id = models.CharField(max_length=64)
    # A second provider handle needed later: Click `click_paydoc_id` (payment id for reversal).
    provider_ref = models.CharField(max_length=64, blank=True)
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    refunded_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    status = models.CharField(
        max_length=10, choices=PaymentStatus.choices, default=PaymentStatus.PENDING
    )
    # Payme `params.time` (ms since epoch): Payme's own creation time, needed for its 12 h timeout
    # and for GetStatement.
    provider_time = models.BigIntegerField(null=True, blank=True)
    # Short, PII-free provider state: {"reason": 5}, {"click_error": -4}, ...
    raw_state = models.JSONField(default=dict, blank=True)
    performed_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            # 7.1: a provider callback is never processed twice for the same transaction.
            models.UniqueConstraint(
                fields=["provider", "external_id"], name="payment_provider_ext"
            ),
            # At most one open transaction per booking and provider (Payme one-time account).
            models.UniqueConstraint(
                fields=["booking", "provider"],
                condition=Q(status="PENDING"),
                name="payment_one_pending_per_provider",
            ),
            models.CheckConstraint(condition=Q(amount__gt=0), name="payment_amount_positive"),
            models.CheckConstraint(
                condition=Q(refunded_amount__gte=0) & Q(refunded_amount__lte=F("amount")),
                name="payment_refunded_within_amount",
            ),
            models.CheckConstraint(
                condition=Q(status__in=PaymentStatus.values), name="payment_status_valid"
            ),
        ]
        indexes = [
            models.Index(fields=["status", "created_at"], name="payment_status_created"),
            # The "paid after the booking died" sweep scans only unrefunded PAID rows.
            models.Index(
                fields=["performed_at"],
                condition=Q(status="PAID", refunded_amount=0),
                name="payment_paid_open",
            ),
        ]

    def __str__(self) -> str:
        return f"Payment({self.provider}:{self.external_id}, {self.status})"


class Refund(BaseModel):
    # NULL only for a MANUAL / DONE record of money that has no Payment row to refund from (legacy
    # or hand-repaired data): the promise is still on the books and a person settles it.
    payment = models.ForeignKey(
        Payment, on_delete=models.PROTECT, related_name="refunds", null=True, blank=True
    )
    booking = models.ForeignKey(
        "bookings.Booking", on_delete=models.PROTECT, related_name="refunds"
    )
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    status = models.CharField(
        max_length=10, choices=RefundStatus.choices, default=RefundStatus.PENDING
    )
    reason = models.CharField(max_length=24, choices=RefundReason.choices)
    # One refund per intent: "cancel:<booking id>", "auto:<payment id>". The unique key is what
    # makes creating a refund idempotent and a refund reach the provider only once.
    idempotency_key = models.CharField(max_length=80, unique=True)
    provider_ref = models.CharField(max_length=64, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    # Error CODE only ("click_error_-4", "timeout"): never a URL, header, body or personal data.
    last_error = models.CharField(max_length=120, blank=True)
    next_attempt_at = models.DateTimeField(null=True, blank=True)
    done_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            models.CheckConstraint(condition=Q(amount__gt=0), name="refund_amount_positive"),
            models.CheckConstraint(
                condition=Q(status__in=RefundStatus.values), name="refund_status_valid"
            ),
            models.CheckConstraint(
                condition=Q(payment__isnull=False) | Q(status__in=("MANUAL", "DONE")),
                name="refund_payment_or_manual",
            ),
        ]
        indexes = [models.Index(fields=["status", "updated_at"], name="refund_status_updated")]

    def __str__(self) -> str:
        return f"Refund({self.pk}, {self.status})"


class WebhookEvent(BaseModel):
    """Audit trail of provider callbacks and the basis of ``retry_failed_webhooks``.

    Only safe fields: no signature, no Authorization header, no body. ``external_id`` is the
    provider's transaction id, ``booking_id`` the order it referred to (when it was a UUID).
    """

    provider = models.CharField(max_length=10, choices=PaymentProvider.choices)
    method = models.CharField(max_length=32)
    external_id = models.CharField(max_length=64, blank=True)
    booking_id = models.UUIDField(null=True, blank=True)
    result_code = models.IntegerField(help_text="0 = accepted; otherwise the protocol error code.")
    remote_ip = models.GenericIPAddressField(null=True, blank=True)
    duration_ms = models.PositiveIntegerField(default=0)

    class Meta:
        ordering = ["-created_at", "id"]
        indexes = [
            models.Index(fields=["provider", "created_at"], name="webhook_provider_time"),
            models.Index(fields=["provider", "external_id"], name="webhook_provider_ext"),
            models.Index(fields=["result_code", "created_at"], name="webhook_result_time"),
            models.Index(fields=["created_at"], name="webhook_created"),  # retention purge
        ]

    def __str__(self) -> str:
        return f"{self.provider}.{self.method} -> {self.result_code}"
