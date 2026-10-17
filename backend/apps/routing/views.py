"""GET /api/v1/routes. Thin view: validation in serializers, logic in services."""

from drf_spectacular.utils import extend_schema
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.serializers import ErrorSerializer

from . import services
from .errors import RouteNotFoundError
from .osrm_client import RouteNotFound
from .serializers import RouteQuerySerializer, RouteResponseSerializer, validated_points
from .throttling import RoutesThrottle


class RouteView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_classes = [RoutesThrottle]

    @extend_schema(
        operation_id="routes_get",
        summary="Driving route with turn-by-turn steps",
        description=(
            "Route from `from_*` to `to_*`. `source` is `osrm` for a real road route or "
            "`fallback` for a straight-line estimate when the routing server is down. "
            "The start point is rounded to 4 decimals (~11 m) for caching, so the first "
            "geometry point may differ from the requested start by a few metres. "
            "Re-request when the user is more than 50 m from the line. "
            "400 `route_too_far`: a point is outside the service area (ROUTING_BBOX) or the "
            "points are farther apart than ROUTING_MAX_STRAIGHT_KM (default 2000 km). "
            "404 `route_not_found`: no drivable route / a point is not within 500 m of a road. "
            "`approximate` is true exactly when `source` is `fallback`."
        ),
        parameters=[RouteQuerySerializer],
        responses={
            200: RouteResponseSerializer,
            400: ErrorSerializer,
            401: ErrorSerializer,
            404: ErrorSerializer,
            429: ErrorSerializer,
            503: ErrorSerializer,
        },
    )
    def get(self, request):
        src, dst = validated_points(request.query_params)
        try:
            return Response(services.get_route(src, dst))
        except RouteNotFound:
            raise RouteNotFoundError from None
