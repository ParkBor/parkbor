from decimal import Decimal

from django.conf import settings
from django.contrib.postgres.fields import RangeOperators
from django.core.exceptions import ImproperlyConfigured
from django.db import models
from django.db.models import F, Func, Q

from apps.core.models import BaseModel

from .constraints import PostgresOnlyCheckConstraint, PostgresOnlyExclusionConstraint
from .fields import PortableDateTimeRangeField
from .state import (
    BLOCKING_STATUSES,
    BookingKind,
    BookingStatus,
    OverstayStatus,
    status_write_is_allowed,
)


class StatusWriteForbidden(ImproperlyConfigured):
    """``Booking.status`` was written outside ``apps.bookings.services``."""


class ImmutableRecord(ImproperlyConfigured):
    """Attempt to change or delete an append-only row (BookingEvent)."""


def _guard_status_write() -> None:
    if not status_write_is_allowed():
        raise StatusWriteForbidden(
            "Booking.status can only change through apps.bookings.services (6.2)."
        )


def _range_bound(function: str) -> Func:
    """``lower(period)`` / ``upper(period)`` as a timestamptz expression (PostgreSQL CHECK)."""
    return Func(F("period"), function=function, output_field=models.DateTimeField())


class BookingQuerySet(models.QuerySet):
    def update(self, **kwargs):
        if "status" in kwargs:
            _guard_status_write()
        return super().update(**kwargs)

    def bulk_update(self, objs, fields, batch_size=None):
        if "status" in fields:
            _guard_status_write()
        return super().bulk_update(objs, fields, batch_size)

    def bulk_create(self, objs, *args, **kwargs):
        objs = list(objs)
        if any(obj.status != BookingStatus.PENDING_PAYMENT for obj in objs):
            _guard_status_write()
        for obj in objs:  # bulk_create skips save(): keep the derived columns right
            obj.starts_at, obj.ends_at = obj.period.lower, obj.period.upper
        return super().bulk_create(objs, *args, **kwargs)

    def delete(self):
        raise ImmutableRecord("Bookings are never deleted; they are cancelled/expired.")


class Booking(BaseModel):
    # NULL only for a walk-in (a car registered at the gate without an account, kind WALK_IN);
    # an ONLINE booking always has a user and a vehicle (CHECK booking_online_has_user_vehicle).
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="bookings",
    )
    kind = models.CharField(max_length=10, choices=BookingKind.choices, default=BookingKind.ONLINE)
    # PROTECT: a slot/zone/lot with bookings cannot be deleted (parking.services answers 409).
    slot = models.ForeignKey("parking.Slot", on_delete=models.PROTECT, related_name="bookings")
    vehicle = models.ForeignKey(
        "vehicles.Vehicle", on_delete=models.PROTECT, null=True, blank=True, related_name="bookings"
    )
    # The plate as it was when the booking was made: editing the vehicle later must not rewrite
    # history (operators match this value at check-in).
    vehicle_plate = models.CharField(max_length=12)
    # Half-open [start, end). Source of truth and the EXCLUDE operand.
    period = PortableDateTimeRangeField()
    # Scalar copies of period.lower/upper, derived in save(); they make overlap/due queries
    # identical on PostgreSQL and SQLite and plain btree-indexable. PostgreSQL additionally
    # enforces starts_at = lower(period) and ends_at = upper(period) with a CHECK.
    starts_at = models.DateTimeField(editable=False)
    ends_at = models.DateTimeField(editable=False)
    status = models.CharField(
        max_length=20, choices=BookingStatus.choices, default=BookingStatus.PENDING_PAYMENT
    )
    # Frozen at creation: later tariff/hours changes never touch an existing booking.
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    # What the payment provider actually collected (Step 8 sets it when confirming). Refunds are
    # computed from this, never from `amount`.
    paid_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    refund_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    # Time parked after the booking end, priced at check-out (Step 9). The money is collected
    # in cash at the gate (no online payment yet): the operator marks it collected or leaves it
    # due. It never changes `amount` / `paid_amount`, so refund maths stays untouched.
    overstay_minutes = models.PositiveIntegerField(default=0)
    overstay_amount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    overstay_status = models.CharField(
        max_length=10, choices=OverstayStatus.choices, default=OverstayStatus.NONE
    )
    # The overstay / walk-in charge hit a limit, had no (usable) tariff: only an OWNER / ADMIN may
    # settle it (checkout "override" + note). Set at check-out, cleared when it is settled.
    overstay_needs_review = models.BooleanField(default=False)
    hold_expires_at = models.DateTimeField(null=True, blank=True)
    # Which provider's checkout the driver chose at creation ("payme" | "click"; Step 8a). It
    # decides the payment_url of GET /bookings/{id}; empty on bookings that predate payments.
    payment_provider = models.CharField(max_length=10, blank=True, default="")
    # The QR token is stateless (django.core.signing, see qr.py); the one-time nonce lives here
    # (Redis only speeds the check up): qr_nonce_used_at marks it spent.
    qr_nonce = models.CharField(max_length=43, blank=True)
    qr_nonce_used_at = models.DateTimeField(null=True, blank=True)
    # sha256 of the ENTRY nonce that was spent at check-in. A repeat scan of an entry code is
    # only recognised as "already inside" (and shown amber, not green) when its nonce hashes to
    # this value; any other code is outdated. Empty on bookings that predate Step 9.
    checkin_nonce_hash = models.CharField(max_length=64, blank=True, default="")
    # The tariff as it was when the booking (or walk-in) was made: {"price_per_hour", "rules"}.
    # Overstay and walk-in fees use it, so a later tariff change cannot reprice a stay that
    # started under the old one. NULL on older rows: the current tariff is used then.
    tariff_snapshot = models.JSONField(null=True, blank=True)
    checked_in_at = models.DateTimeField(null=True, blank=True)
    checked_out_at = models.DateTimeField(null=True, blank=True)
    cancelled_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = BookingQuerySet.as_manager()

    class Meta:
        ordering = ["-starts_at", "id"]
        constraints = [
            PostgresOnlyExclusionConstraint(
                name="booking_no_overlap",
                expressions=[("slot", RangeOperators.EQUAL), ("period", RangeOperators.OVERLAPS)],
                index_type="GIST",
                condition=Q(status__in=BLOCKING_STATUSES),
            ),
            # One CAR cannot occupy two slots at the same time. A car is identified by its
            # normalised plate (snapshot), not by the Vehicle row: the same plate registered under
            # two accounts is still one physical car. btree_gist indexes varchar through its
            # text operator class.
            PostgresOnlyExclusionConstraint(
                name="booking_vehicle_no_overlap",
                expressions=[
                    ("vehicle_plate", RangeOperators.EQUAL),
                    ("period", RangeOperators.OVERLAPS),
                ],
                index_type="GIST",
                condition=Q(status__in=BLOCKING_STATUSES),
            ),
            PostgresOnlyCheckConstraint(
                name="booking_period_valid",
                condition=(
                    Q(period__isempty=False)
                    & Q(period__lower_inf=False)
                    & Q(period__upper_inf=False)
                    & Q(period__lower_inc=True)
                    & Q(period__upper_inc=False)
                    & Q(starts_at=_range_bound("lower"))
                    & Q(ends_at=_range_bound("upper"))
                ),
            ),
            models.CheckConstraint(
                condition=Q(starts_at__lt=F("ends_at")), name="booking_start_lt_end"
            ),
            models.CheckConstraint(
                condition=Q(status__in=BookingStatus.values), name="booking_status_valid"
            ),
            models.CheckConstraint(condition=Q(amount__gte=0), name="booking_amount_non_negative"),
            models.CheckConstraint(
                condition=Q(kind=BookingKind.WALK_IN)
                | (Q(user__isnull=False) & Q(vehicle__isnull=False)),
                name="booking_online_has_user_vehicle",
            ),
            models.CheckConstraint(
                condition=Q(kind__in=BookingKind.values), name="booking_kind_valid"
            ),
            models.CheckConstraint(
                condition=Q(overstay_status__in=OverstayStatus.values)
                & (
                    Q(overstay_status=OverstayStatus.NONE, overstay_amount=0)
                    | (~Q(overstay_status=OverstayStatus.NONE) & Q(overstay_amount__gt=0))
                ),
                name="booking_overstay_valid",
            ),
            models.CheckConstraint(
                condition=Q(paid_amount__gte=0) & Q(paid_amount__lte=F("amount")),
                name="booking_paid_within_amount",
            ),
            models.CheckConstraint(
                condition=Q(refund_amount__gte=0) & Q(refund_amount__lte=F("amount")),
                name="booking_refund_within_amount",
            ),
            # A refund is a share of what was actually collected: never more than paid_amount.
            models.CheckConstraint(
                condition=Q(refund_amount__lte=F("paid_amount")),
                name="booking_refund_within_paid",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "starts_at"], name="booking_status_start"),
            models.Index(fields=["status", "ends_at"], name="booking_status_end"),
            # Hot paths: overlap probes only look at live bookings; the hold sweep only at
            # unpaid ones. Partial indexes stay tiny however much history accumulates.
            models.Index(
                fields=["slot", "starts_at"],
                condition=Q(status__in=BLOCKING_STATUSES),
                name="booking_live_slot_start",
            ),
            models.Index(
                fields=["hold_expires_at"],
                condition=Q(status=BookingStatus.PENDING_PAYMENT),
                name="booking_pending_hold",
            ),
            # walk-ins have no user: keep them out of the per-user history index
            models.Index(
                fields=["user", "-starts_at"],
                condition=Q(user__isnull=False),
                name="booking_user_start",
            ),
            models.Index(fields=["vehicle_plate", "starts_at"], name="booking_plate_start"),
        ]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._persisted_status: str | None = None

    @classmethod
    def from_db(cls, db, field_names, values):
        instance = super().from_db(db, field_names, values)
        instance._persisted_status = instance.__dict__.get("status")
        return instance

    def refresh_from_db(self, using=None, fields=None, **kwargs):
        super().refresh_from_db(using=using, fields=fields, **kwargs)
        if fields is None or "status" in fields:  # a partial refresh must not move the baseline
            self._persisted_status = self.__dict__.get("status")

    def save(self, *, force_insert=False, force_update=False, using=None, update_fields=None):
        """Keyword-only on purpose: a positional ``update_fields`` could dodge the guards."""
        if update_fields is not None:
            update_fields = frozenset(update_fields)
        touches_status = update_fields is None or "status" in update_fields
        if touches_status and self.status != self._persisted_status:
            # New rows must start PENDING_PAYMENT; later changes need the services.py guard.
            initial_ok = self._state.adding and self.status == BookingStatus.PENDING_PAYMENT
            if not initial_ok:
                _guard_status_write()
        if update_fields is None or "period" in update_fields:
            self.starts_at, self.ends_at = self.period.lower, self.period.upper
            if update_fields is not None:
                update_fields = update_fields | {"starts_at", "ends_at"}
        super().save(
            force_insert=force_insert,
            force_update=force_update,
            using=using,
            update_fields=update_fields,
        )
        self._persisted_status = self.status

    def delete(self, *args, **kwargs):
        raise ImmutableRecord("Bookings are never deleted; they are cancelled/expired.")

    def __str__(self) -> str:
        return f"Booking({self.pk}, {self.status})"


class _EventQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise ImmutableRecord("BookingEvent rows are append-only.")

    def delete(self):
        raise ImmutableRecord("BookingEvent rows are append-only.")


class BookingEvent(BaseModel):
    """One state change (or notable action such as an extension). Never updated or deleted."""

    booking = models.ForeignKey(Booking, on_delete=models.PROTECT, related_name="events")
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="+",
        help_text="NULL = the system (Celery task).",
    )
    from_status = models.CharField(max_length=20, blank=True)  # empty = creation
    to_status = models.CharField(max_length=20)
    reason = models.CharField(max_length=64)
    meta = models.JSONField(default=dict, blank=True)

    objects = _EventQuerySet.as_manager()

    class Meta:
        ordering = ["created_at", "id"]
        indexes = [
            models.Index(fields=["booking", "created_at"], name="booking_event_history"),
            models.Index(fields=["to_status", "created_at"], name="booking_event_outcome"),
        ]

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ImmutableRecord("BookingEvent rows are append-only.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ImmutableRecord("BookingEvent rows are append-only.")

    def __str__(self) -> str:
        return f"{self.from_status or '-'} -> {self.to_status} ({self.reason})"


class BookingSetting(models.Model):
    """A runtime override of one admin-editable booking setting (ARCHITECTURE 9.3.1 ``settings``).

    The environment (``BOOKING_*``) stays the default; a row here wins over it. Only the keys in
    ``apps.bookings.conf.EDITABLE_SETTINGS`` are ever written, always through
    ``apps.adminpanel.services.update_settings`` (validation + audit)."""

    key = models.CharField(max_length=40, primary_key=True)
    value = models.PositiveIntegerField()
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )

    def __str__(self) -> str:
        return f"{self.key}={self.value}"
