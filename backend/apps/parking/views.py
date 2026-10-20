"""Driver-facing parking endpoints. Views stay thin; the search lives in services/selectors."""

from drf_spectacular.utils import extend_schema
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.exceptions import NotFoundError
from apps.core.serializers import ErrorSerializer

from . import selectors, services
from .serializers import (
    NearbyQuerySerializer,
    NearbyResponseSerializer,
    ParkingDetailSerializer,
    present_detail,
    present_search,
    validated_query,
)
from .throttling import NearbyThrottle, ParkingDetailThrottle


class NearbyParkingsView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [NearbyThrottle]

    @extend_schema(
        operation_id="parkings_nearby",
        summary="Nearest parking lots with free slots",
        parameters=[NearbyQuerySerializer],
        responses={
            200: NearbyResponseSerializer,
            400: ErrorSerializer,
            401: ErrorSerializer,
            429: ErrorSerializer,
        },
    )
    def get(self, request):
        query = validated_query(request.query_params)
        return Response(present_search(services.search_nearby(query)))


class ParkingDetailView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [ParkingDetailThrottle]

    @extend_schema(
        operation_id="parkings_retrieve",
        summary="One ACTIVE parking lot with availability by slot type (404 for anything else)",
        responses={
            200: ParkingDetailSerializer,
            401: ErrorSerializer,
            404: ErrorSerializer,
            429: ErrorSerializer,
        },
    )
    def get(self, request, pk):
        detail = selectors.active_lot_detail(pk)
        if detail is None:
            raise NotFoundError("Parking lot not found.")
        return Response(present_detail(detail))
