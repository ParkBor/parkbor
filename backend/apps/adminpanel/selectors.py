"""Read queries of the admin operations API (users, bookings, payments, refunds, audit).

Every queryset is scoped by the caller's role: ADMIN sees everything, OWNER only what belongs to
own parking lots, anyone else nothing. A foreign object therefore answers 404 (no existence
oracle). ``select_related`` / ``prefetch_related`` keep list endpoints at a constant query count.
"""

from django.db.models import Prefetch, QuerySet

from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.bookings.models import Booking, BookingEvent
from apps.core.permissions import is_owner, is_super_admin
from apps.payments.admin_api import (
    needs_attention_q,
    payments_for_staff,
    payments_queryset,
    refunds_for_staff,
)

BOOKING_LOT_OWNER = "slot__zone__parking_lot__owner_id"


def _scope(queryset: QuerySet, user, owner_path: str) -> QuerySet:
    if is_super_admin(user):
        return queryset
    if is_owner(user):
        return queryset.filter(**{owner_path: user.pk})
    return queryset.none()


def users_for_admin() -> QuerySet[User]:
    return User.objects.all().order_by("-created_at", "id")


def bookings_for_staff(user) -> QuerySet[Booking]:
    queryset = Booking.objects.select_related("slot__zone__parking_lot").prefetch_related("refunds")
    return _scope(queryset, user, BOOKING_LOT_OWNER).order_by("-starts_at", "id")


def booking_detail_for_staff(user) -> QuerySet[Booking]:
    return bookings_for_staff(user).prefetch_related(
        Prefetch(
            "events",
            queryset=BookingEvent.objects.select_related("actor").order_by("created_at", "id"),
        ),
        Prefetch("payments", queryset=payments_queryset()),
    )


def audit_logs() -> QuerySet[AuditLog]:
    return AuditLog.objects.all().order_by("-created_at", "id")


__all__ = [
    "audit_logs",
    "booking_detail_for_staff",
    "bookings_for_staff",
    "needs_attention_q",
    "payments_for_staff",
    "refunds_for_staff",
    "users_for_admin",
]
