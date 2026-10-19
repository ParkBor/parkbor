"""Driver review endpoints (thin: validation here, rules in services)."""

from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.exceptions import NotFoundError
from apps.core.pagination import StandardPagination
from apps.core.serializers import error_responses as errors
from apps.parking.models import LotStatus, ParkingLot

from . import selectors, services
from .serializers import PagedPublicReviewSerializer, PublicReviewSerializer, ReviewCreateSerializer
from .throttling import ReviewReadThrottle, ReviewWriteThrottle


class LotReviewsView(APIView):
    permission_classes = [IsAuthenticated]

    def get_throttles(self):
        throttle = ReviewWriteThrottle if self.request.method == "POST" else ReviewReadThrottle
        return [throttle()]

    @extend_schema(
        operation_id="parkings_reviews_list",
        summary="Published reviews of a parking lot (newest first; no author information)",
        responses={200: PagedPublicReviewSerializer, **errors(401, 404, 429)},
    )
    def get(self, request, pk):
        if not ParkingLot.objects.filter(pk=pk, status=LotStatus.ACTIVE).exists():
            raise NotFoundError("Parking lot not found.")
        paginator = StandardPagination()
        page = paginator.paginate_queryset(selectors.published_for_lot(pk), request, view=self)
        return paginator.get_paginated_response(PublicReviewSerializer(page, many=True).data)

    @extend_schema(
        operation_id="parkings_reviews_create",
        summary="Review a COMPLETED booking of your own (one review per booking)",
        request=ReviewCreateSerializer,
        responses={201: PublicReviewSerializer, **errors(400, 401, 404, 409, 429, 503)},
    )
    def post(self, request, pk):
        body = ReviewCreateSerializer(data=request.data)
        body.is_valid(raise_exception=True)
        review = services.create_review(
            user=request.user,
            lot_id=pk,
            booking_id=body.validated_data["booking_id"],
            rating=body.validated_data["rating"],
            comment=body.validated_data["comment"],
        )
        return Response(PublicReviewSerializer(review).data, status=status.HTTP_201_CREATED)
