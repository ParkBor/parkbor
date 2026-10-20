"""Driver-facing serializers (/parkings/nearby)."""

import math

from rest_framework import serializers

from apps.core.exceptions import DomainValidationError

from .models import SlotType
from .ranking import SORT_CHOICES, NearbyQuery, NearbySearchResult

DEFAULT_RADIUS_M = 3000
MIN_QUERY_RADIUS_M, MAX_QUERY_RADIUS_M = 100, 10_000
DEFAULT_LIMIT, MAX_LIMIT = 20, 50
SCORE_DIGITS = 4


class NearbyQuerySerializer(serializers.Serializer):
    lat = serializers.FloatField(min_value=-90, max_value=90, help_text="Latitude, -90..90.")
    lng = serializers.FloatField(min_value=-180, max_value=180, help_text="Longitude, -180..180.")
    radius = serializers.IntegerField(
        min_value=MIN_QUERY_RADIUS_M,
        max_value=MAX_QUERY_RADIUS_M,
        default=DEFAULT_RADIUS_M,
        help_text="Search radius in metres. Widened automatically when fewer than 3 lots match.",
    )
    slot_type = serializers.ChoiceField(
        choices=SlotType.choices,
        required=False,
        help_text="Only lots with a free slot of this type; counts and price are for this type.",
    )
    limit = serializers.IntegerField(min_value=1, max_value=MAX_LIMIT, default=DEFAULT_LIMIT)
    sort = serializers.ChoiceField(choices=SORT_CHOICES, default="recommended")
    only_open = serializers.BooleanField(
        default=False, help_text="Only lots open now (Asia/Tashkent working hours)."
    )

    def _finite(self, value: float) -> float:
        if not math.isfinite(value):  # NaN passes min/max validators because it compares False
            raise serializers.ValidationError("A finite number is required.")
        return value

    def validate_lat(self, value: float) -> float:
        return self._finite(value)

    def validate_lng(self, value: float) -> float:
        return self._finite(value)

    def to_query(self) -> NearbyQuery:
        data = self.validated_data
        return NearbyQuery(
            lat=data["lat"],
            lng=data["lng"],
            radius_m=data["radius"],
            slot_type=data.get("slot_type"),
            limit=data["limit"],
            sort=data["sort"],
            only_open=data["only_open"],
        )


def validated_query(params) -> NearbyQuery:
    """Parse query params; invalid input raises the project's 400 {detail, code} error."""
    serializer = NearbyQuerySerializer(data=params)
    if not serializer.is_valid():
        problems = "; ".join(
            f"{field}: {' '.join(str(e) for e in errors)}"
            for field, errors in serializer.errors.items()
        )
        raise DomainValidationError(problems)
    return serializer.to_query()


class NearbyLocationSerializer(serializers.Serializer):
    lat = serializers.FloatField()
    lng = serializers.FloatField()


class NearbyParkingSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()
    address = serializers.CharField()
    location = NearbyLocationSerializer()
    distance_m = serializers.IntegerField(
        help_text="Straight-line distance from the request point."
    )
    duration_s = serializers.IntegerField(
        allow_null=True, help_text="Road travel time (OSRM); null when routing is unavailable."
    )
    free_slots = serializers.IntegerField()
    total_slots = serializers.IntegerField()
    price_per_hour = serializers.DecimalField(
        max_digits=12,
        decimal_places=2,
        allow_null=True,
        help_text="Cheapest (or slot_type) tariff.",
    )
    rating = serializers.FloatField(allow_null=True)
    is_open = serializers.BooleanField()
    score = serializers.FloatField(
        allow_null=True, help_text="Recommendation score, lower is better."
    )


class NearbyResponseSerializer(serializers.Serializer):
    results = NearbyParkingSerializer(many=True)
    radius_used_m = serializers.IntegerField()
    count = serializers.IntegerField()


def present_search(search: NearbySearchResult) -> dict:
    """Flatten domain results into the response contract."""
    rows = [
        {
            "id": item.lot.id,
            "name": item.lot.name,
            "address": item.lot.address,
            "location": {"lat": item.lot.lat, "lng": item.lot.lng},
            "distance_m": round(item.distance_m),
            "duration_s": item.duration_s,
            "free_slots": item.lot.free_slots,
            "total_slots": item.lot.total_slots,
            "price_per_hour": item.lot.price_per_hour,
            "rating": item.lot.rating,
            "is_open": item.is_open,
            "score": None if item.score is None else round(item.score, SCORE_DIGITS),
        }
        for item in search.results
    ]
    return {
        "results": NearbyParkingSerializer(rows, many=True).data,
        "radius_used_m": search.radius_used_m,
        "count": len(rows),
    }


class SlotTypeAvailabilitySerializer(serializers.Serializer):
    type = serializers.CharField()
    free_slots = serializers.IntegerField(help_text="Slots of this type that are FREE right now.")
    total_slots = serializers.IntegerField()
    price_per_hour = serializers.DecimalField(max_digits=12, decimal_places=2, allow_null=True)


class ParkingDetailSerializer(serializers.Serializer):
    """Same fields as a nearby item (minus distance / route / score) plus the slot types."""

    id = serializers.UUIDField()
    name = serializers.CharField()
    address = serializers.CharField()
    location = NearbyLocationSerializer()
    free_slots = serializers.IntegerField()
    total_slots = serializers.IntegerField()
    price_per_hour = serializers.DecimalField(
        max_digits=12, decimal_places=2, allow_null=True, help_text="Cheapest tariff."
    )
    rating = serializers.FloatField(allow_null=True)
    is_open = serializers.BooleanField()
    open_time = serializers.TimeField(allow_null=True)
    close_time = serializers.TimeField(allow_null=True)
    slot_types = SlotTypeAvailabilitySerializer(many=True)


def present_detail(detail: dict, *, now=None) -> dict:
    from django.utils import timezone

    from .ranking import is_open_now

    return {
        "id": detail["id"],
        "name": detail["name"],
        "address": detail["address"],
        "location": {"lat": detail["lat"], "lng": detail["lng"]},
        "free_slots": detail["free_slots"],
        "total_slots": detail["total_slots"],
        "price_per_hour": detail["price_per_hour"],
        "rating": detail["rating"] or None,  # 0 means "no reviews yet"
        "is_open": is_open_now(detail["open_time"], detail["close_time"], now or timezone.now()),
        "open_time": detail["open_time"],
        "close_time": detail["close_time"],
        "slot_types": detail["slot_types"],
    }
