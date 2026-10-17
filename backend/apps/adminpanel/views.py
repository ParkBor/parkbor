from django_filters.rest_framework import DjangoFilterBackend
from drf_spectacular.utils import extend_schema
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.filters import SearchFilter
from rest_framework.response import Response

from apps.core.pagination import StandardPagination
from apps.core.permissions import IsOwnerOfLot, IsSuperAdmin
from apps.parking import selectors, services

from .filters import (
    ParkingLotFilter,
    SlotFilter,
    StableOrderingFilter,
    TariffFilter,
    ZoneFilter,
)
from .operator_views import OperatorStaffMixin
from .serializers import (
    ParkingLotSerializer,
    SlotBulkResultSerializer,
    SlotBulkSerializer,
    SlotSerializer,
    TariffSerializer,
    ZoneSerializer,
)


class AdminModelViewSet(viewsets.ModelViewSet):
    """Shared config: ADMIN sees all, OWNER only own lots (queryset scoping + object check)."""

    permission_classes = [IsSuperAdmin | IsOwnerOfLot]
    pagination_class = StandardPagination
    filter_backends = [DjangoFilterBackend, SearchFilter, StableOrderingFilter]
    scope_selector = None

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return self.serializer_class.Meta.model.objects.none()
        return type(self).scope_selector(self.request.user)


class ParkingLotViewSet(OperatorStaffMixin, AdminModelViewSet):
    serializer_class = ParkingLotSerializer
    filterset_class = ParkingLotFilter
    search_fields = ["name", "address"]
    ordering_fields = ["name", "created_at", "status", "total_slots", "free_slots", "rating"]
    scope_selector = staticmethod(selectors.lots_for_user)

    def perform_create(self, serializer):
        serializer.instance = services.create_lot(data=serializer.validated_data)

    def perform_update(self, serializer):
        serializer.instance = services.update_lot(
            lot=serializer.instance, data=serializer.validated_data, actor=self.request.user
        )

    def perform_destroy(self, instance):
        services.delete_lot(lot=instance, actor=self.request.user)

    def _transition(self, request, name):
        lot = services.change_lot_status(lot=self.get_object(), actor=request.user, action=name)
        return Response(self.get_serializer(lot).data)

    @extend_schema(request=None, responses=ParkingLotSerializer)
    @action(detail=True, methods=["post"], permission_classes=[IsSuperAdmin])
    def approve(self, request, pk=None):
        """PENDING_REVIEW -> ACTIVE (ADMIN only)."""
        return self._transition(request, "approve")

    @extend_schema(request=None, responses=ParkingLotSerializer)
    @action(detail=True, methods=["post"], permission_classes=[IsSuperAdmin])
    def suspend(self, request, pk=None):
        """Block a lot (ADMIN only)."""
        return self._transition(request, "suspend")

    @extend_schema(request=None, responses=ParkingLotSerializer)
    @action(detail=True, methods=["post"], permission_classes=[IsSuperAdmin])
    def restore(self, request, pk=None):
        """SUSPENDED -> ACTIVE (ADMIN only)."""
        return self._transition(request, "restore")


class ZoneViewSet(AdminModelViewSet):
    serializer_class = ZoneSerializer
    filterset_class = ZoneFilter
    search_fields = ["name"]
    ordering_fields = ["name", "floor", "created_at"]
    scope_selector = staticmethod(selectors.zones_for_user)

    def perform_create(self, serializer):
        serializer.instance = services.save_zone(instance=None, data=serializer.validated_data)

    def perform_update(self, serializer):
        serializer.instance = services.save_zone(
            instance=serializer.instance, data=serializer.validated_data
        )

    def perform_destroy(self, instance):
        services.delete_zone(zone=instance)


class SlotViewSet(AdminModelViewSet):
    serializer_class = SlotSerializer
    filterset_class = SlotFilter
    search_fields = ["code"]
    ordering_fields = ["code", "distance_to_entrance", "status", "type", "created_at"]
    scope_selector = staticmethod(selectors.slots_for_user)

    def perform_create(self, serializer):
        serializer.instance = services.save_slot(instance=None, data=serializer.validated_data)

    def perform_update(self, serializer):
        serializer.instance = services.save_slot(
            instance=serializer.instance, data=serializer.validated_data
        )

    def perform_destroy(self, instance):
        services.delete_slot(slot=instance)

    @extend_schema(request=SlotBulkSerializer, responses={201: SlotBulkResultSerializer})
    @action(detail=False, methods=["post"], url_path="bulk")
    def bulk(self, request):
        """Bulk-create slots, e.g. zone A, codes A-1..A-50."""
        serializer = SlotBulkSerializer(data=request.data, context=self.get_serializer_context())
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        slots = services.bulk_create_slots(
            zone=data["zone"],
            prefix=data["prefix"],
            start=data["start"],
            end=data["end"],
            slot_type=data["type"],
            distance_to_entrance=data["distance_to_entrance"],
        )
        body = {"created": len(slots), "codes": [s.code for s in slots]}
        return Response(body, status=status.HTTP_201_CREATED)


class TariffViewSet(AdminModelViewSet):
    serializer_class = TariffSerializer
    filterset_class = TariffFilter
    ordering_fields = ["slot_type", "price_per_hour", "created_at"]
    scope_selector = staticmethod(selectors.tariffs_for_user)

    def perform_create(self, serializer):
        serializer.instance = services.save_tariff(instance=None, data=serializer.validated_data)

    def perform_update(self, serializer):
        serializer.instance = services.save_tariff(
            instance=serializer.instance, data=serializer.validated_data
        )
