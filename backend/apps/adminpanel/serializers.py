import re
from decimal import Decimal

from django.contrib.auth import get_user_model
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.core.geo import point_to_lnglat, polygon_to_ring
from apps.core.permissions import ROLE_ADMIN, ROLE_OWNER, is_super_admin
from apps.parking import selectors
from apps.parking.models import ParkingLot, Slot, SlotStatus, SlotType, Tariff, Zone
from apps.parking.validators import (
    MAX_BULK_SLOTS,
    MAX_DISTANCE_TO_ENTRANCE,
    MAX_SLOT_NUMBER,
    SLOT_CODE_PATTERN,
    RulesError,
    validate_tariff_rules,
)


@extend_schema_field(
    {
        "type": "object",
        "properties": {"lat": {"type": "number"}, "lng": {"type": "number"}},
        "required": ["lat", "lng"],
    }
)
class LocationField(serializers.Field):
    """{"lat": 41.31, "lng": 69.24} <-> (lng, lat); services turn it into a Point."""

    default_error_messages = {"invalid": "Expected an object with numeric lat and lng."}

    def to_representation(self, value):
        lng, lat = point_to_lnglat(value)
        return {"lat": lat, "lng": lng}

    def to_internal_value(self, data):
        if not isinstance(data, dict):
            self.fail("invalid")
        raw_lat, raw_lng = data.get("lat"), data.get("lng")
        if isinstance(raw_lat, bool) or isinstance(raw_lng, bool):
            self.fail("invalid")
        try:
            lat, lng = float(raw_lat), float(raw_lng)
        except (TypeError, ValueError):
            self.fail("invalid")
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):  # also rejects NaN
            raise serializers.ValidationError("lat must be in [-90, 90] and lng in [-180, 180].")
        return (lng, lat)


@extend_schema_field(
    {"type": "array", "items": {"type": "array", "items": {"type": "number"}}, "nullable": True}
)
class AreaField(serializers.Field):
    """Polygon exterior ring as [[lng, lat], ...] (closed, at least 4 points)."""

    def to_representation(self, value):
        return [list(point) for point in polygon_to_ring(value)]

    def to_internal_value(self, data):
        if not isinstance(data, list) or len(data) < 4:
            raise serializers.ValidationError("A ring needs at least 4 [lng, lat] points.")
        try:
            ring = [(float(p[0]), float(p[1])) for p in data]
        except (TypeError, ValueError, IndexError, KeyError) as exc:
            raise serializers.ValidationError("Points must be [lng, lat] numbers.") from exc
        if ring[0] != ring[-1]:
            raise serializers.ValidationError("The ring must be closed (first == last point).")
        if any(not (-180 <= x <= 180 and -90 <= y <= 90) for x, y in ring):
            raise serializers.ValidationError("Coordinates out of range.")
        return ring


@extend_schema_field(OpenApiTypes.UUID)
class _ScopedField(serializers.PrimaryKeyRelatedField):
    """PK field whose choices are limited to what the acting user may see."""

    selector = None

    def get_queryset(self):
        request = self.context.get("request")
        user = getattr(request, "user", None)
        return type(self).selector(user)


@extend_schema_field(OpenApiTypes.UUID)
class ScopedLotField(_ScopedField):
    selector = staticmethod(selectors.lots_for_user)


@extend_schema_field(OpenApiTypes.UUID)
class ScopedZoneField(_ScopedField):
    selector = staticmethod(selectors.zones_for_user)


@extend_schema_field(OpenApiTypes.UUID)
class _OwnerField(serializers.PrimaryKeyRelatedField):
    def get_queryset(self):
        return get_user_model().objects.filter(role__in=[ROLE_OWNER, ROLE_ADMIN])


class ParkingLotSerializer(serializers.ModelSerializer):
    location = LocationField()
    area = AreaField(required=False, allow_null=True)
    owner = _OwnerField(required=False)

    class Meta:
        model = ParkingLot
        fields = [
            "id",
            "owner",
            "name",
            "address",
            "location",
            "area",
            "status",
            "open_time",
            "close_time",
            "total_slots",
            "free_slots",
            "rating",
            "require_plate_on_checkin",
            "created_at",
        ]
        read_only_fields = ["id", "status", "total_slots", "free_slots", "rating", "created_at"]

    def validate(self, attrs):
        user = self.context["request"].user
        if not is_super_admin(user):
            attrs.pop("owner", None)  # owners can never assign/transfer a lot
            if self.instance is None:
                attrs["owner"] = user
        elif self.instance is None and "owner" not in attrs:
            attrs["owner"] = user  # an admin who names nobody owns the lot (can hand it over later)
        open_time = attrs.get("open_time", getattr(self.instance, "open_time", None))
        close_time = attrs.get("close_time", getattr(self.instance, "close_time", None))
        if (open_time is None) != (close_time is None):
            raise serializers.ValidationError(
                {"close_time": "open_time and close_time must be given together."}
            )
        if open_time is not None and open_time == close_time:
            raise serializers.ValidationError(
                {"close_time": "open_time and close_time must differ; use null/null for 24/7."}
            )
        return attrs


class _ImmutableParentMixin:
    """The parent FK (lot/zone) may not change after creation."""

    parent_field = ""

    def validate(self, attrs):
        parent = attrs.get(self.parent_field)
        if (
            self.instance is not None
            and parent is not None
            and parent.pk != getattr(self.instance, f"{self.parent_field}_id")
        ):
            raise serializers.ValidationError(
                {self.parent_field: "Cannot be changed after creation."}
            )
        return attrs


class ZoneSerializer(_ImmutableParentMixin, serializers.ModelSerializer):
    parent_field = "parking_lot"
    parking_lot = ScopedLotField()

    class Meta:
        model = Zone
        fields = ["id", "parking_lot", "name", "floor", "created_at"]
        read_only_fields = ["id", "created_at"]

    def validate(self, attrs):
        attrs = super().validate(attrs)
        lot = attrs.get("parking_lot", getattr(self.instance, "parking_lot", None))
        name = attrs.get("name", getattr(self.instance, "name", None))
        clash = Zone.objects.filter(parking_lot=lot, name=name)
        if self.instance is not None:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise serializers.ValidationError({"name": "A zone with this name already exists."})
        return attrs


class SlotSerializer(_ImmutableParentMixin, serializers.ModelSerializer):
    parent_field = "zone"
    zone = ScopedZoneField()

    class Meta:
        model = Slot
        fields = ["id", "zone", "code", "type", "status", "distance_to_entrance", "created_at"]
        read_only_fields = ["id", "created_at"]

    def validate_code(self, value):
        if not re.fullmatch(SLOT_CODE_PATTERN, value):
            raise serializers.ValidationError(
                "Use letters, digits, '-' and '_' only (1-20 characters)."
            )
        return value

    def validate_status(self, value):
        """Owners only toggle FREE <-> OUT_OF_SERVICE; RESERVED/OCCUPIED belong to bookings."""
        if is_super_admin(self.context["request"].user):
            return value
        current = self.instance.status if self.instance else SlotStatus.FREE
        if value == current:
            return value
        allowed = {SlotStatus.FREE, SlotStatus.OUT_OF_SERVICE}
        if value not in allowed or current not in allowed:
            raise serializers.ValidationError(
                "Owners can only switch a slot between FREE and OUT_OF_SERVICE."
            )
        return value

    def validate(self, attrs):
        attrs = super().validate(attrs)
        zone = attrs.get("zone", getattr(self.instance, "zone", None))
        code = attrs.get("code", getattr(self.instance, "code", None))
        clash = Slot.objects.filter(zone=zone, code=code)
        if self.instance is not None:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise serializers.ValidationError({"code": "This code already exists in the zone."})
        return attrs


class SlotBulkSerializer(serializers.Serializer):
    zone = ScopedZoneField()
    prefix = serializers.RegexField(r"^[A-Za-z0-9]{1,10}$", help_text="Zone letter, e.g. A")
    start = serializers.IntegerField(min_value=1, max_value=MAX_SLOT_NUMBER)
    end = serializers.IntegerField(min_value=1, max_value=MAX_SLOT_NUMBER)
    type = serializers.ChoiceField(choices=SlotType.choices, default=SlotType.STANDARD)
    distance_to_entrance = serializers.IntegerField(
        min_value=0, max_value=MAX_DISTANCE_TO_ENTRANCE, default=0
    )

    def validate(self, attrs):
        if attrs["end"] < attrs["start"]:
            raise serializers.ValidationError({"end": "end must be >= start."})
        if attrs["end"] - attrs["start"] + 1 > MAX_BULK_SLOTS:
            raise serializers.ValidationError(
                {"end": f"At most {MAX_BULK_SLOTS} slots per request."}
            )
        return attrs


class SlotBulkResultSerializer(serializers.Serializer):
    created = serializers.IntegerField()
    codes = serializers.ListField(child=serializers.CharField())


class TariffSerializer(_ImmutableParentMixin, serializers.ModelSerializer):
    parent_field = "parking_lot"
    parking_lot = ScopedLotField()
    price_per_hour = serializers.DecimalField(
        max_digits=12, decimal_places=2, min_value=Decimal("0")
    )

    class Meta:
        model = Tariff
        fields = ["id", "parking_lot", "slot_type", "price_per_hour", "rules", "created_at"]
        read_only_fields = ["id", "created_at"]

    def validate_rules(self, value):
        try:
            return validate_tariff_rules(value)
        except RulesError as exc:
            raise serializers.ValidationError(str(exc)) from exc

    def validate(self, attrs):
        attrs = super().validate(attrs)
        lot = attrs.get("parking_lot", getattr(self.instance, "parking_lot", None))
        slot_type = attrs.get("slot_type", getattr(self.instance, "slot_type", None))
        clash = Tariff.objects.filter(parking_lot=lot, slot_type=slot_type)
        if self.instance is not None:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise serializers.ValidationError(
                {"slot_type": "A tariff for this slot type already exists in the lot."}
            )
        return attrs
