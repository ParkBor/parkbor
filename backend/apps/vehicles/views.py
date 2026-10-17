from drf_spectacular.utils import OpenApiResponse, extend_schema, extend_schema_view
from rest_framework import viewsets

from apps.core.permissions import IsRecordOwner
from apps.core.serializers import error_responses as _errors
from apps.core.throttling import AuthenticatedUserThrottle

from . import services
from .models import Vehicle
from .serializers import VehicleSerializer


@extend_schema_view(
    list=extend_schema(
        summary="My vehicles (not paginated: at most 10)",
        responses={200: VehicleSerializer(many=True), **_errors(401, 429)},
    ),
    create=extend_schema(
        summary="Add a vehicle",
        responses={201: VehicleSerializer, **_errors(400, 401, 409, 422, 429)},
    ),
    retrieve=extend_schema(
        summary="One of my vehicles",
        responses={200: VehicleSerializer, **_errors(401, 404, 429)},
    ),
    update=extend_schema(
        summary="Replace a vehicle",
        responses={200: VehicleSerializer, **_errors(400, 401, 404, 409, 429)},
    ),
    partial_update=extend_schema(
        summary="Change a vehicle",
        responses={200: VehicleSerializer, **_errors(400, 401, 404, 409, 429)},
    ),
    destroy=extend_schema(
        summary="Delete a vehicle (archived if it has booking history; 409 if a booking is live)",
        responses={204: OpenApiResponse(description="Deleted."), **_errors(401, 404, 409, 429)},
    ),
)
class VehicleViewSet(viewsets.ModelViewSet):
    """Personal vehicles. Always scoped to the caller; a foreign id is a 404."""

    serializer_class = VehicleSerializer
    permission_classes = [IsRecordOwner]
    throttle_classes = [AuthenticatedUserThrottle]
    pagination_class = None

    def get_queryset(self):
        if getattr(self, "swagger_fake_view", False):
            return Vehicle.objects.none()
        return Vehicle.objects.filter(user=self.request.user, is_archived=False)

    def perform_create(self, serializer):
        serializer.instance = services.create_vehicle(
            user=self.request.user, data=serializer.validated_data
        )

    def perform_update(self, serializer):
        serializer.instance = services.update_vehicle(
            vehicle=serializer.instance, data=serializer.validated_data
        )

    def perform_destroy(self, instance):
        services.delete_vehicle(vehicle=instance)
