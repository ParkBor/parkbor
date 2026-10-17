"""GET /routes: query validation and the response schema (documentation + shape)."""

import math

from rest_framework import serializers

from apps.core.exceptions import DomainValidationError
from apps.routing import limits
from apps.routing.errors import RouteTooFarError
from apps.routing.steps import INSTRUCTION_KEYS

SUPPORTED_MODES = ("driving",)


def _finite(value: float) -> float:
    if not math.isfinite(value):  # NaN passes min/max validators because it compares False
        raise serializers.ValidationError("A finite number is required.")
    return value


def _coordinate(low: int, high: int, help_text: str):
    return serializers.FloatField(
        min_value=low, max_value=high, validators=[_finite], help_text=help_text
    )


class RouteQuerySerializer(serializers.Serializer):
    from_lat = _coordinate(-90, 90, "Start latitude, -90..90.")
    from_lng = _coordinate(-180, 180, "Start longitude, -180..180.")
    to_lat = _coordinate(-90, 90, "Destination latitude, -90..90.")
    to_lng = _coordinate(-180, 180, "Destination longitude, -180..180.")
    mode = serializers.ChoiceField(
        choices=SUPPORTED_MODES, default="driving", help_text="Only `driving` is supported."
    )


def validated_points(params) -> tuple[tuple[float, float], tuple[float, float]]:
    """Parse query params into ((lat, lng), (lat, lng)); invalid input raises a 400 ApiError."""
    if "mode" in params and not params["mode"]:  # DRF would silently apply the default to ""
        raise DomainValidationError("mode: Only 'driving' is supported.")
    serializer = RouteQuerySerializer(data=params)
    if not serializer.is_valid():
        problems = "; ".join(
            f"{field}: {' '.join(str(e) for e in errors)}"
            for field, errors in serializer.errors.items()
        )
        raise DomainValidationError(problems)
    data = serializer.validated_data
    src, dst = (data["from_lat"], data["from_lng"]), (data["to_lat"], data["to_lng"])
    if not limits.route_allowed(src, dst):
        raise RouteTooFarError
    return src, dst


class RouteGeometrySerializer(serializers.Serializer):
    type = serializers.ChoiceField(choices=["LineString"])
    coordinates = serializers.ListField(
        child=serializers.ListField(child=serializers.FloatField(), min_length=2, max_length=2),
        help_text="[[lng, lat], ...] (GeoJSON order).",
    )


class RouteStepLocationSerializer(serializers.Serializer):
    lat = serializers.FloatField()
    lng = serializers.FloatField()


class RouteManeuverSerializer(serializers.Serializer):
    type = serializers.CharField(help_text="OSRM maneuver type, e.g. `turn`.")
    modifier = serializers.CharField(allow_null=True, help_text="OSRM modifier, e.g. `left`.")
    exit = serializers.IntegerField(
        allow_null=True,
        min_value=1,
        max_value=50,
        help_text="Roundabout exit number (1..50) or null.",
    )


class RouteStepSerializer(serializers.Serializer):
    instruction_key = serializers.ChoiceField(
        choices=INSTRUCTION_KEYS, help_text="Localise this key in the app (uz/ru/en)."
    )
    name = serializers.CharField(help_text="Street name (sanitised, may be empty).")
    distance_m = serializers.IntegerField()
    duration_s = serializers.IntegerField()
    location = RouteStepLocationSerializer()
    maneuver = RouteManeuverSerializer()


class RouteResponseSerializer(serializers.Serializer):
    distance_m = serializers.IntegerField()
    duration_s = serializers.IntegerField()
    geometry = RouteGeometrySerializer()
    steps = RouteStepSerializer(many=True)
    source = serializers.ChoiceField(
        choices=["osrm", "fallback"],
        help_text=(
            "`fallback` = OSRM unavailable: a straight line at an assumed 30 km/h. "
            "The app MUST tell the user that this route is only approximate."
        ),
    )
    approximate = serializers.BooleanField(
        help_text="True for `fallback` routes: show a warning (distance/time are estimates)."
    )
