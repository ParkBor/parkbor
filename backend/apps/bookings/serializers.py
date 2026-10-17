"""Driver-facing booking serializers (contract: ARCHITECTURE 9.4)."""

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.parking.models import SlotType
from apps.payments.checkout import payment_url_for, refund_status_for
from apps.payments.models import PaymentProvider

from .models import Booking
from .state import SCOPE_STATUSES, BookingStatus


class AwareDateTimeField(serializers.DateTimeField):
    """ISO 8601 with a UTC offset (``+05:00`` or ``Z``). A naive value is ambiguous: reject it."""

    default_error_messages = {"naive": "A UTC offset is required, e.g. +05:00 or Z."}

    def enforce_timezone(self, value):
        if value.tzinfo is None:
            self.fail("naive")
        return value


class BookingCreateSerializer(serializers.Serializer):
    parking_lot_id = serializers.UUIDField()
    slot_type = serializers.ChoiceField(choices=SlotType.choices)
    vehicle_id = serializers.UUIDField()
    start = AwareDateTimeField()
    end = AwareDateTimeField()
    preferred_slot_id = serializers.UUIDField(required=False, allow_null=True, default=None)
    payment_provider = serializers.ChoiceField(
        choices=PaymentProvider.choices,
        required=False,
        allow_null=True,
        default=None,
        help_text="Checkout to use: payme | click. Omitted or null = the server default.",
    )


class ExtendSerializer(serializers.Serializer):
    end = AwareDateTimeField(help_text="The new end of the booking (later than the current one).")


class BookingListQuerySerializer(serializers.Serializer):
    status = serializers.CharField(
        required=False,
        help_text="One or more statuses, comma separated (e.g. CONFIRMED,ACTIVE).",
    )
    scope = serializers.ChoiceField(
        choices=sorted(SCOPE_STATUSES),
        required=False,
        help_text="active = ACTIVE/OVERSTAY; upcoming = PENDING_PAYMENT/CONFIRMED; history = rest.",
    )

    def validate_status(self, value: str) -> list[str]:
        statuses = [part.strip() for part in value.split(",") if part.strip()]
        unknown = sorted(set(statuses) - set(BookingStatus.values))
        if unknown:
            raise serializers.ValidationError(f"Unknown status: {', '.join(unknown)}.")
        return statuses


class SlotBriefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    code = serializers.CharField()
    zone = serializers.CharField(source="zone.name")
    floor = serializers.IntegerField(source="zone.floor")


class LotBriefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()
    address = serializers.CharField()


class VehicleBriefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    plate_number = serializers.CharField()
    type = serializers.CharField()


class BookingSerializer(serializers.ModelSerializer):
    slot = SlotBriefSerializer()
    parking_lot = LotBriefSerializer(source="slot.zone.parking_lot")
    vehicle = serializers.SerializerMethodField(
        help_text="The plate is the one recorded when the booking was made."
    )
    start = serializers.DateTimeField(source="starts_at")
    end = serializers.DateTimeField(source="ends_at")
    payment_url = serializers.SerializerMethodField(
        help_text="Provider checkout link; only while the booking is PENDING_PAYMENT and its "
        "hold is running (otherwise null). Contains no secret."
    )
    refund_status = serializers.SerializerMethodField(
        help_text="What happens to refund_amount: none | pending | done | manual | failed. "
        "refund_amount is a promise by the cancellation policy, not a payment: show the money as "
        "returned only when this is `done`; `manual` means support returns it by hand."
    )
    payment_provider = serializers.CharField(
        read_only=True,
        help_text="payme | click (empty on bookings created before payments existed).",
    )

    class Meta:
        model = Booking
        fields = [
            "id",
            "status",
            "slot",
            "parking_lot",
            "vehicle",
            "start",
            "end",
            "amount",
            "paid_amount",
            "refund_amount",
            "hold_expires_at",
            "payment_provider",
            "payment_url",
            "refund_status",
            "checked_in_at",
            "checked_out_at",
            "cancelled_at",
            "created_at",
        ]
        read_only_fields = fields

    @extend_schema_field(serializers.URLField(allow_null=True))
    def get_payment_url(self, obj) -> str | None:
        return payment_url_for(obj)

    @extend_schema_field(
        serializers.ChoiceField(choices=["none", "pending", "done", "manual", "failed"])
    )
    def get_refund_status(self, obj) -> str:
        return refund_status_for(obj)

    @extend_schema_field(VehicleBriefSerializer)
    def get_vehicle(self, obj) -> dict:
        return {
            "id": obj.vehicle_id,
            "plate_number": obj.vehicle_plate,
            "type": obj.vehicle.type if obj.vehicle_id else None,  # walk-ins have no vehicle row
        }


class ExtendedBookingSerializer(BookingSerializer):
    """Booking + the price of the added time; pass ``context={"extra_amount": Decimal}``."""

    extra_amount = serializers.SerializerMethodField()

    class Meta(BookingSerializer.Meta):
        fields = [*BookingSerializer.Meta.fields, "extra_amount"]
        read_only_fields = fields

    @extend_schema_field(serializers.DecimalField(max_digits=12, decimal_places=2))
    def get_extra_amount(self, obj) -> str:
        return format(self.context["extra_amount"], "f")


class CancelPreviewSerializer(serializers.Serializer):
    can_cancel = serializers.BooleanField()
    refund_percent = serializers.IntegerField()
    refund_amount = serializers.DecimalField(max_digits=12, decimal_places=2)


class QrSerializer(serializers.Serializer):
    qr_token = serializers.CharField(help_text="Signed one-time token to encode in the QR image.")
    expires_at = serializers.DateTimeField()
    purpose = serializers.ChoiceField(
        choices=["entry", "exit"],
        help_text="entry: show it at the entrance (CONFIRMED booking). exit: show it when "
        "leaving (ACTIVE / OVERSTAY booking); it is made when you check in.",
    )


class PagedBookingSerializer(serializers.Serializer):
    count = serializers.IntegerField()
    next = serializers.URLField(allow_null=True)
    previous = serializers.URLField(allow_null=True)
    results = BookingSerializer(many=True)


# --- quotes -----------------------------------------------------------------------------------


class QuoteQuerySerializer(serializers.Serializer):
    """``from`` / ``to`` are Python keywords-adjacent names in the URL; mapped in the view."""

    start = AwareDateTimeField()
    end = AwareDateTimeField()
    slot_type = serializers.ChoiceField(choices=SlotType.choices, required=False)


class RequiredSlotTypeQuerySerializer(QuoteQuerySerializer):
    slot_type = serializers.ChoiceField(choices=SlotType.choices)


class AvailabilitySerializer(serializers.Serializer):
    slot_type = serializers.ChoiceField(choices=SlotType.choices, allow_null=True)
    start = serializers.DateTimeField()
    end = serializers.DateTimeField()
    total = serializers.IntegerField(help_text="Working slots (not out of service).")
    available = serializers.IntegerField(help_text="Slots that can take the whole period.")
    is_open = serializers.BooleanField(help_text="The period fits the lot's working hours.")


class PriceSegmentSerializer(serializers.Serializer):
    start = serializers.DateTimeField()
    end = serializers.DateTimeField()
    minutes = serializers.IntegerField()
    coefficient = serializers.DecimalField(max_digits=8, decimal_places=4, normalize_output=True)
    amount = serializers.DecimalField(max_digits=12, decimal_places=2)


class PriceSerializer(serializers.Serializer):
    slot_type = serializers.ChoiceField(choices=SlotType.choices)
    start = serializers.DateTimeField()
    end = serializers.DateTimeField()
    price_per_hour = serializers.DecimalField(max_digits=12, decimal_places=2)
    total_minutes = serializers.IntegerField()
    free_minutes = serializers.IntegerField()
    billed_minutes = serializers.IntegerField()
    segments = PriceSegmentSerializer(many=True)
    subtotal = serializers.DecimalField(max_digits=12, decimal_places=2)
    occupancy = serializers.DecimalField(
        max_digits=5, decimal_places=4, normalize_output=True, allow_null=True
    )
    dynamic_factor = serializers.DecimalField(max_digits=8, decimal_places=4, normalize_output=True)
    total = serializers.DecimalField(max_digits=12, decimal_places=2)
    available_slots = serializers.IntegerField()
