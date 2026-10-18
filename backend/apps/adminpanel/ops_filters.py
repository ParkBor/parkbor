"""Filters of the admin operations lists. Related-object filters accept only what the caller may
see, so a foreign id is indistinguishable from a missing one."""

import django_filters
from django.db.models import Q

from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.bookings.models import Booking
from apps.bookings.state import BookingKind, BookingStatus, OverstayStatus
from apps.parking import selectors as parking_selectors
from apps.payments.models import Payment, PaymentProvider, PaymentStatus, Refund, RefundStatus
from apps.reviews.models import Review, ReviewStatus

from . import selectors

SEARCH_MAX_LENGTH = 100


def _user(request):
    return getattr(request, "user", None)


def _lots(request):
    return parking_selectors.lots_for_user(_user(request))


def _bookings(request):
    return Booking.objects.filter(pk__in=selectors.bookings_for_staff(_user(request)).values("pk"))


class RangeFilterSet(django_filters.FilterSet):
    """``?from=`` / ``?to=`` (ISO 8601 with an offset, both inclusive) on ``range_field``."""

    range_field = "created_at"
    from_ = django_filters.IsoDateTimeFilter(method="filter_from")
    to_ = django_filters.IsoDateTimeFilter(method="filter_to")

    def __init__(self, data=None, *args, **kwargs):
        if data is not None:
            data = data.copy()
            for name in ("from", "to"):
                if name in data:
                    data[f"{name}_"] = data[name]
        super().__init__(data, *args, **kwargs)

    def filter_from(self, queryset, name, value):
        return queryset.filter(**{f"{self.range_field}__gte": value})

    def filter_to(self, queryset, name, value):
        return queryset.filter(**{f"{self.range_field}__lte": value})


class UserFilter(django_filters.FilterSet):
    role = django_filters.ChoiceFilter(choices=User.Role.choices)
    is_active = django_filters.BooleanFilter()
    search = django_filters.CharFilter(method="filter_search")

    class Meta:
        model = User
        fields: list[str] = []

    def filter_search(self, queryset, name, value):
        value = value.strip()[:SEARCH_MAX_LENGTH]
        if not value:
            return queryset
        return queryset.filter(
            Q(telegram_username__icontains=value.lstrip("@"))
            | Q(first_name__icontains=value)
            | Q(last_name__icontains=value)
        )


class BookingFilter(RangeFilterSet):
    range_field = "starts_at"
    status = django_filters.ChoiceFilter(choices=BookingStatus.choices)
    kind = django_filters.ChoiceFilter(choices=BookingKind.choices)
    overstay_status = django_filters.ChoiceFilter(choices=OverstayStatus.choices)
    parking_lot = django_filters.ModelChoiceFilter(
        field_name="slot__zone__parking_lot", queryset=_lots
    )
    search = django_filters.CharFilter(method="filter_search")

    class Meta:
        model = Booking
        fields: list[str] = []

    def filter_search(self, queryset, name, value):
        """By licence plate (any case, spaces and dashes ignored)."""
        raw = value.strip()[:SEARCH_MAX_LENGTH]
        compact = "".join(ch for ch in raw.upper() if ch.isalnum())
        if not compact:
            return queryset
        return queryset.filter(vehicle_plate__icontains=compact)


class PaymentFilter(RangeFilterSet):
    status = django_filters.ChoiceFilter(choices=PaymentStatus.choices)
    provider = django_filters.ChoiceFilter(choices=PaymentProvider.choices)
    booking = django_filters.ModelChoiceFilter(queryset=_bookings)

    class Meta:
        model = Payment
        fields: list[str] = []


class RefundFilter(django_filters.FilterSet):
    status = django_filters.ChoiceFilter(choices=RefundStatus.choices)
    booking = django_filters.ModelChoiceFilter(queryset=_bookings)
    needs_attention = django_filters.BooleanFilter(method="filter_needs_attention")

    class Meta:
        model = Refund
        fields: list[str] = []

    def filter_needs_attention(self, queryset, name, value):
        attention = selectors.needs_attention_q()
        return queryset.filter(attention) if value else queryset.exclude(attention)


class AuditLogFilter(RangeFilterSet):
    action = django_filters.CharFilter(lookup_expr="exact", max_length=64)
    target_type = django_filters.CharFilter(lookup_expr="exact", max_length=32)
    target_id = django_filters.CharFilter(lookup_expr="exact", max_length=64)
    actor = django_filters.UUIDFilter(field_name="actor_id")

    class Meta:
        model = AuditLog
        fields: list[str] = []


class ReviewFilter(django_filters.FilterSet):
    status = django_filters.ChoiceFilter(choices=ReviewStatus.choices)
    parking_lot = django_filters.ModelChoiceFilter(queryset=_lots)
    rating = django_filters.NumberFilter()

    class Meta:
        model = Review
        fields: list[str] = []
