import django_filters
from django.contrib.auth import get_user_model
from rest_framework.filters import OrderingFilter

from apps.core.permissions import ROLE_ADMIN, ROLE_OWNER, is_super_admin
from apps.parking import selectors
from apps.parking.models import ParkingLot, Slot, Tariff, Zone


class StableOrderingFilter(OrderingFilter):
    """OrderingFilter that always ends with ``id`` so pages never overlap on equal keys."""

    def get_ordering(self, request, queryset, view):
        ordering = super().get_ordering(request, queryset, view)
        if not ordering:
            return ordering
        ordering = list(ordering)
        if "id" not in ordering and "-id" not in ordering:
            ordering.append("id")
        return ordering


# Related-object filters only accept what the caller may see, so a foreign id is
# indistinguishable from a non-existent one (no existence oracle).
def _scoped(selector):
    def queryset(request):
        user = getattr(request, "user", None)
        return selector(user) if user is not None else selector(None)

    return queryset


def _owners(request):
    user = getattr(request, "user", None)
    users = get_user_model().objects
    if is_super_admin(user):
        return users.filter(role__in=[ROLE_ADMIN, ROLE_OWNER])
    return users.filter(pk=getattr(user, "pk", None))


class ParkingLotFilter(django_filters.FilterSet):
    owner = django_filters.ModelChoiceFilter(queryset=_owners)

    class Meta:
        model = ParkingLot
        fields = {"status": ["exact"], "name": ["icontains"]}


class ZoneFilter(django_filters.FilterSet):
    parking_lot = django_filters.ModelChoiceFilter(queryset=_scoped(selectors.lots_for_user))

    class Meta:
        model = Zone
        fields = {"floor": ["exact"], "name": ["icontains"]}


class SlotFilter(django_filters.FilterSet):
    zone = django_filters.ModelChoiceFilter(queryset=_scoped(selectors.zones_for_user))
    parking_lot = django_filters.ModelChoiceFilter(
        field_name="zone__parking_lot", queryset=_scoped(selectors.lots_for_user)
    )

    class Meta:
        model = Slot
        fields = {"type": ["exact"], "status": ["exact"], "code": ["icontains"]}


class TariffFilter(django_filters.FilterSet):
    parking_lot = django_filters.ModelChoiceFilter(queryset=_scoped(selectors.lots_for_user))

    class Meta:
        model = Tariff
        fields = {"slot_type": ["exact"]}
