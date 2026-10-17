"""Operator API shapes (ARCHITECTURE 9.2). PII-minimal: a plate and times, never a name or phone."""

from rest_framework import serializers

from apps.bookings.models import Booking
from apps.bookings.state import BookingKind, OverstayStatus
from apps.parking.models import ParkingLot, SlotStatus, SlotType
from apps.vehicles.models import VehicleType

QR_TOKEN_MAX = 4096  # real tokens are ~200 characters; the verifier itself refuses > 1024


# --- requests ---------------------------------------------------------------------------------


class CheckInSerializer(serializers.Serializer):
    qr_token = serializers.CharField(max_length=QR_TOKEN_MAX, help_text="The scanned entry QR.")
    parking_lot_id = serializers.UUIDField(
        required=False,
        help_text="The lot the app is working in. A valid code of another lot is refused as "
        "wrong_lot. REQUIRED (400 parking_lot_required) when the caller may operate more than "
        "one lot.",
    )
    plate_number = serializers.CharField(
        required=False,
        max_length=32,
        help_text="Optional: the plate read from the car. When given it must match the booking "
        "(409 plate_mismatch).",
    )


class CheckOutSerializer(serializers.Serializer):
    qr_token = serializers.CharField(
        required=False, max_length=QR_TOKEN_MAX, help_text="The scanned EXIT QR."
    )
    booking_id = serializers.UUIDField(
        required=False, help_text="Manual check-out (needs plate_number)."
    )
    plate_number = serializers.CharField(
        required=False,
        max_length=32,
        help_text="Plate read from the car; must match the booking (manual check-out).",
    )
    collect = serializers.BooleanField(
        default=False,
        help_text="true = the operator took the cash that is due (overstay / walk-in fee).",
    )
    parking_lot_id = serializers.UUIDField(required=False)
    override = serializers.BooleanField(
        default=False,
        help_text="OWNER / ADMIN only, with booking_id: check an ONLINE booking out without its "
        "exit QR. Needs a note; recorded in the booking history and the audit log.",
    )
    note = serializers.CharField(
        required=False, allow_blank=True, max_length=200, help_text="Why (required with override)."
    )

    def validate(self, attrs):
        if ("qr_token" in attrs) == ("booking_id" in attrs):
            raise serializers.ValidationError("Give exactly one of qr_token or booking_id.")
        if "booking_id" in attrs and not attrs.get("plate_number"):
            raise serializers.ValidationError(
                {"plate_number": "The plate number is required with booking_id."}
            )
        if attrs["override"]:
            if "booking_id" not in attrs:
                raise serializers.ValidationError({"override": "Only with booking_id."})
            if not attrs.get("note", "").strip():
                raise serializers.ValidationError({"note": "A note is required with override."})
        return attrs


class WalkInSerializer(serializers.Serializer):
    slot_id = serializers.UUIDField()
    plate_number = serializers.CharField(max_length=32)
    vehicle_type = serializers.ChoiceField(
        choices=VehicleType.choices,
        help_text="What the operator sees; it must fit the slot type (422 vehicle_slot_mismatch).",
    )


class SlotStatusSerializer(serializers.Serializer):
    status = serializers.ChoiceField(
        choices=[SlotStatus.FREE.value, SlotStatus.OUT_OF_SERVICE.value],
        help_text="Physical state set by hand. OCCUPIED / RESERVED come from check-in / walk-in.",
    )
    force = serializers.BooleanField(
        default=False,
        help_text="OWNER / ADMIN only: take the slot out of service although bookings wait for it.",
    )


# --- responses --------------------------------------------------------------------------------


class SlotRefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    code = serializers.CharField()
    zone = serializers.CharField(source="zone.name")
    floor = serializers.IntegerField(source="zone.floor")
    type = serializers.ChoiceField(choices=SlotType.choices)


class LotRefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class OperatorBookingSerializer(serializers.ModelSerializer):
    """A booking as the gate sees it. The plate is the one recorded when it was made."""

    plate_number = serializers.CharField(source="vehicle_plate", read_only=True)
    slot = SlotRefSerializer()
    parking_lot = LotRefSerializer(source="slot.zone.parking_lot")
    start = serializers.DateTimeField(source="starts_at")
    end = serializers.DateTimeField(source="ends_at")
    kind = serializers.ChoiceField(choices=BookingKind.choices)
    overstay_status = serializers.ChoiceField(choices=OverstayStatus.choices)

    class Meta:
        model = Booking
        fields = [
            "id",
            "status",
            "kind",
            "plate_number",
            "slot",
            "parking_lot",
            "start",
            "end",
            "amount",
            "paid_amount",
            "checked_in_at",
            "checked_out_at",
            "overstay_minutes",
            "overstay_amount",
            "overstay_status",
            "overstay_needs_review",
        ]
        read_only_fields = fields


class OverstayRuleSerializer(serializers.Serializer):
    free_minutes = serializers.IntegerField(help_text="Always 0: no free window after the end.")
    block_minutes = serializers.IntegerField()
    price_per_block = serializers.DecimalField(
        max_digits=12,
        decimal_places=2,
        allow_null=True,
        help_text="Base price of one started block (null: the lot has no tariff for the slot). "
        "Time-of-day and occupancy coefficients may raise it.",
    )
    collected_at_exit = serializers.BooleanField(help_text="Always true: cash at the gate.")


class NextActionSerializer(serializers.Serializer):
    checkout_by = serializers.DateTimeField(help_text="The booking end; later costs extra.")
    overstay = OverstayRuleSerializer()


class CheckInResponseSerializer(serializers.Serializer):
    allowed = serializers.BooleanField(
        help_text="true only for a real admission (green). false with result "
        "`already_checked_in`: the car is already inside, this scan admits nobody (amber). "
        "Refusals (red) are error bodies."
    )
    result = serializers.ChoiceField(choices=["checked_in", "already_checked_in"])
    booking = OperatorBookingSerializer()
    next = NextActionSerializer()


class OverstayChargeSerializer(serializers.Serializer):
    minutes = serializers.IntegerField()
    amount = serializers.DecimalField(max_digits=12, decimal_places=2)
    status = serializers.ChoiceField(choices=OverstayStatus.choices)


class CheckOutResponseSerializer(serializers.Serializer):
    allowed = serializers.BooleanField(
        help_text="true only when THIS call checked the car out (`completed`). false with "
        "`already_completed`: the car had already left; this scan changes nothing (amber)."
    )
    result = serializers.ChoiceField(choices=["completed", "already_completed"])
    booking = OperatorBookingSerializer()
    actual_minutes = serializers.IntegerField(help_text="Whole minutes the car was parked.")
    overstay = OverstayChargeSerializer()
    to_collect = serializers.DecimalField(
        max_digits=12,
        decimal_places=2,
        help_text="Cash still to take at the gate (overstay due, or a walk-in's unpaid fee).",
    )


class WalkInResponseSerializer(serializers.Serializer):
    result = serializers.ChoiceField(choices=["registered"])
    booking = OperatorBookingSerializer()
    valid_until = serializers.DateTimeField(
        help_text="End of the walk-in period (cut short by the next booking of the slot)."
    )


class OperatorLotSerializer(serializers.ModelSerializer):
    class Meta:
        model = ParkingLot
        fields = [
            "id",
            "name",
            "address",
            "status",
            "open_time",
            "close_time",
            "total_slots",
            "free_slots",
        ]
        read_only_fields = fields


class PagedOperatorLotSerializer(serializers.Serializer):
    count = serializers.IntegerField()
    next = serializers.URLField(allow_null=True)
    previous = serializers.URLField(allow_null=True)
    results = OperatorLotSerializer(many=True)


class MapBookingSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    status = serializers.CharField()
    kind = serializers.ChoiceField(choices=BookingKind.choices)
    plate_number = serializers.CharField(
        allow_null=True,
        help_text="null for a waiting booking that starts more than 2 hours from now.",
    )
    start = serializers.DateTimeField()
    end = serializers.DateTimeField()


class MapSlotSerializer(serializers.Serializer):
    id = serializers.UUIDField(source="slot.id")
    code = serializers.CharField(source="slot.code")
    zone = serializers.CharField(source="slot.zone.name")
    floor = serializers.IntegerField(source="slot.zone.floor")
    type = serializers.ChoiceField(choices=SlotType.choices, source="slot.type")
    status = serializers.ChoiceField(choices=SlotStatus.choices, source="slot.status")
    current_booking = MapBookingSerializer(source="current", allow_null=True)
    next_booking = MapBookingSerializer(source="next", allow_null=True)


class SlotMapSerializer(serializers.Serializer):
    parking_lot = OperatorLotSerializer()
    slots = MapSlotSerializer(many=True)
    truncated = serializers.BooleanField(
        help_text="true if the lot has more slots than the map returns (OPERATOR_MAP_MAX_SLOTS)."
    )


class InviteAcceptSerializer(serializers.Serializer):
    code = serializers.CharField(max_length=64, help_text="The invitation code the owner gave you.")


class InviteAcceptedSerializer(serializers.Serializer):
    parking_lot = LotRefSerializer()


class SlotChangeSerializer(serializers.Serializer):
    id = serializers.UUIDField(source="slot.id")
    code = serializers.CharField(source="slot.code")
    status = serializers.ChoiceField(choices=SlotStatus.choices, source="slot.status")
    affected_bookings = serializers.IntegerField(
        help_text="Waiting bookings left behind by a forced out-of-service (0 otherwise)."
    )
