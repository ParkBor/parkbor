"""Payments side of the admin panel API (Step 11b): scoped querysets, serializers, filters and the
money aggregates of the dashboard.

Lives INSIDE the payments app on purpose: the ``Payment`` / ``Refund`` models are never imported
by another app (lint test ``test_only_lifecycle_writes_payment_and_refund_status``). The admin
panel app only uses the names defined here. Read-only: nothing in this module changes a status.
"""

import re
from datetime import datetime, tzinfo

import django_filters
from django.db.models import Count, DecimalField, ExpressionWrapper, F, Q, QuerySet, Sum
from django.db.models.functions import TruncDate
from rest_framework import serializers

from apps.bookings.models import Booking
from apps.core.filters import RangeFilterSet
from apps.core.permissions import is_owner, is_super_admin

from .models import Payment, PaymentProvider, PaymentStatus, Refund, RefundStatus

OPERATOR_FAILED = "operator_failed"
BOOKING_LOT_OWNER = "booking__slot__zone__parking_lot__owner_id"
PAID_STATES = (PaymentStatus.PAID, PaymentStatus.REFUNDED)
NET_AMOUNT = ExpressionWrapper(
    F("amount") - F("refunded_amount"), output_field=DecimalField(max_digits=14, decimal_places=2)
)


def _scope(queryset: QuerySet, user, owner_path: str) -> QuerySet:
    if is_super_admin(user):
        return queryset
    if is_owner(user):
        return queryset.filter(**{owner_path: user.pk})
    return queryset.none()


def payments_for_staff(user) -> QuerySet[Payment]:
    return _scope(Payment.objects.all(), user, BOOKING_LOT_OWNER).order_by("-created_at", "id")


def refunds_for_staff(user) -> QuerySet[Refund]:
    return _scope(Refund.objects.all(), user, BOOKING_LOT_OWNER).order_by("-created_at", "id")


def payments_queryset() -> QuerySet[Payment]:
    """For ``Prefetch("payments", ...)`` on a booking."""
    return Payment.objects.order_by("created_at", "id")


def needs_attention_q() -> Q:
    """MANUAL (a person returns the money by hand) and FAILED refunds, except the ones an operator
    gave up on (final: nothing left to do)."""
    return Q(status__in=(RefundStatus.MANUAL, RefundStatus.FAILED)) & ~Q(
        status=RefundStatus.FAILED, last_error=OPERATOR_FAILED
    )


# --- dashboard aggregates --------------------------------------------------------------------


def revenue_totals(lot_ids, *, since: datetime, until: datetime, today_since: datetime) -> dict:
    """Net revenue (amount - refunded) of PAID / REFUNDED payments performed in
    ``[since, until)``: ``{"month": ..., "today": ...}`` (today = from ``today_since``)."""
    return Payment.objects.filter(
        booking__slot__zone__parking_lot__in=lot_ids,
        status__in=PAID_STATES,
        performed_at__gte=since,
        performed_at__lt=until,
    ).aggregate(
        today=Sum(NET_AMOUNT, filter=Q(performed_at__gte=today_since)),
        month=Sum(NET_AMOUNT),
    )


def daily_revenue(lot_ids, *, since: datetime, until: datetime, tz: tzinfo) -> dict:
    """``{local date: {"revenue", "bookings"}}`` for payments performed in ``[since, until)``."""
    rows = (
        Payment.objects.filter(
            booking__slot__zone__parking_lot__in=lot_ids,
            status__in=PAID_STATES,
            performed_at__gte=since,
            performed_at__lt=until,
        )
        .annotate(day=TruncDate("performed_at", tzinfo=tz))
        .values("day")
        .annotate(revenue=Sum(NET_AMOUNT), bookings=Count("booking", distinct=True))
        .order_by("day")
    )
    return {row["day"]: row for row in rows}


def attention_count(lot_ids) -> int:
    return Refund.objects.filter(
        needs_attention_q(), booking__slot__zone__parking_lot__in=lot_ids
    ).count()


# --- serializers (shape: packages/api-client adminOps.ts) ------------------------------------


class AdminPaymentSerializer(serializers.ModelSerializer):
    """No ``external_id`` / ``provider_ref`` / ``raw_state``: provider internals stay private."""

    booking = serializers.PrimaryKeyRelatedField(read_only=True)

    class Meta:
        model = Payment
        fields = [
            "id",
            "booking",
            "provider",
            "amount",
            "refunded_amount",
            "status",
            "performed_at",
            "cancelled_at",
            "created_at",
        ]
        read_only_fields = fields


_CODE = re.compile(r"^[a-z0-9_.:\-]{1,60}$")


def error_code_for(value: str, *, admin: bool) -> str:
    """``Refund.last_error`` is written by our own code as a machine code, but it is shown through
    a filter anyway: ADMIN sees it when it has the code shape (anything else is "unknown_error");
    OWNER only learns THAT an attempt failed (``"error"``), never why (provider details)."""
    if not value:
        return ""
    if not admin:
        return "error"
    return value if _CODE.match(value) else "unknown_error"


class AdminRefundSerializer(serializers.ModelSerializer):
    payment = serializers.PrimaryKeyRelatedField(read_only=True, allow_null=True)
    booking = serializers.PrimaryKeyRelatedField(read_only=True)

    class Meta:
        model = Refund
        fields = [
            "id",
            "payment",
            "booking",
            "amount",
            "status",
            "reason",
            "attempts",
            "last_error",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def to_representation(self, instance):
        data = super().to_representation(instance)
        request = self.context.get("request")  # no request = the stricter OWNER view
        data["last_error"] = error_code_for(
            instance.last_error, admin=is_super_admin(getattr(request, "user", None))
        )
        return data


# --- filters ---------------------------------------------------------------------------------


def _visible_bookings(request) -> QuerySet[Booking]:
    return _scope(
        Booking.objects.all(), getattr(request, "user", None), "slot__zone__parking_lot__owner_id"
    )


class PaymentFilter(RangeFilterSet):
    status = django_filters.ChoiceFilter(choices=PaymentStatus.choices)
    provider = django_filters.ChoiceFilter(choices=PaymentProvider.choices)
    booking = django_filters.ModelChoiceFilter(queryset=_visible_bookings)

    class Meta:
        model = Payment
        fields: list[str] = []


class RefundFilter(django_filters.FilterSet):
    status = django_filters.ChoiceFilter(choices=RefundStatus.choices)
    booking = django_filters.ModelChoiceFilter(queryset=_visible_bookings)
    needs_attention = django_filters.BooleanFilter(method="filter_needs_attention")

    class Meta:
        model = Refund
        fields: list[str] = []

    def filter_needs_attention(self, queryset, name, value):
        attention = needs_attention_q()
        return queryset.filter(attention) if value else queryset.exclude(attention)
