"""Driver-facing parking endpoints. Views stay thin; the search lives in services/selectors."""

from drf_spectacular.utils import extend_schema
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.serializers import ErrorSerializer

from . import services
from .serializers import (
    NearbyQuerySerializer,
    NearbyResponseSerializer,
    present_search,
    validated_query,
)
from .throttling import NearbyThrottle


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
