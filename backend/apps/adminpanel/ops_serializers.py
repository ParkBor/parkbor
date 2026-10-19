"""Response / request shapes of the admin operations API (match packages/api-client adminOps.ts)."""

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.bookings.conf import EDITABLE_SETTINGS
from apps.bookings.models import Booking, BookingEvent
from apps.bookings.state import BookingKind, BookingStatus, OverstayStatus
from apps.payments.admin_api import AdminPaymentSerializer, AdminRefundSerializer
from apps.payments.checkout import refund_status_for
from apps.payments.refunds import OPERATOR_NOTE_LENGTH, clean_note

# --- shared ---------------------------------------------------------------------------------------


class PageSerializer(serializers.Serializer):
    count = serializers.IntegerField()
    next = serializers.URLField(allow_null=True)
    previous = serializers.URLField(allow_null=True)


class StrictSerializer(serializers.Serializer):
    """Rejects unknown keys (no silent mass-assignment of fields the form never meant to send)."""

    def to_internal_value(self, data):
        if hasattr(data, "keys"):
            unknown = sorted(set(data.keys()) - set(self.fields))
            if unknown:
                raise serializers.ValidationError({name: "Unknown field." for name in unknown})
        return super().to_internal_value(data)


# --- users ----------------------------------------------------------------------------------------


class AdminUserSerializer(serializers.ModelSerializer):
    """No phone, no Telegram id: only what the user table needs."""

    class Meta:
        model = User
        fields = [
            "id",
            "telegram_username",
            "first_name",
            "last_name",
            "role",
            "is_active",
            "created_at",
        ]
        read_only_fields = fields


class PagedAdminUserSerializer(PageSerializer):
    results = AdminUserSerializer(many=True)


class UserUpdateSerializer(StrictSerializer):
    role = serializers.ChoiceField(choices=User.Role.choices, required=False)
    is_active = serializers.BooleanField(required=False)

    def validate(self, attrs):
        if not attrs:
            raise serializers.ValidationError("Send role and/or is_active.")
        return attrs


# --- bookings -------------------------------------------------------------------------------------


class AdminSlotRefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    code = serializers.CharField()
    zone = serializers.CharField(source="zone.name")
    floor = serializers.IntegerField(source="zone.floor")
    type = serializers.CharField()


class AdminLotRefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


ACTOR_LABELS = ("driver", "operator", "owner", "admin", "system")


class BookingEventSerializer(serializers.ModelSerializer):
    """The actor is a ROLE label, never a user id: an owner reading a history learns who kind of
    person acted, not which account."""

    actor = serializers.SerializerMethodField()

    class Meta:
        model = BookingEvent
        fields = ["id", "created_at", "from_status", "to_status", "reason", "actor"]
        read_only_fields = fields

    @extend_schema_field(serializers.ChoiceField(choices=list(ACTOR_LABELS), allow_null=True))
    def get_actor(self, obj) -> str:
        return obj.actor.role.lower() if obj.actor_id else "system"


class AdminBookingSerializer(serializers.ModelSerializer):
    plate_number = serializers.CharField(source="vehicle_plate", read_only=True)
    slot = AdminSlotRefSerializer(read_only=True)
    parking_lot = AdminLotRefSerializer(source="slot.zone.parking_lot", read_only=True)
    start = serializers.DateTimeField(source="starts_at", read_only=True)
    end = serializers.DateTimeField(source="ends_at", read_only=True)
    refund_status = serializers.SerializerMethodField()
    status = serializers.ChoiceField(choices=BookingStatus.choices, read_only=True)
    kind = serializers.ChoiceField(choices=BookingKind.choices, read_only=True)
    overstay_status = serializers.ChoiceField(choices=OverstayStatus.choices, read_only=True)

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
            "refund_amount",
            "refund_status",
            "payment_provider",
            "checked_in_at",
            "checked_out_at",
            "cancelled_at",
            "overstay_minutes",
            "overstay_amount",
            "overstay_status",
            "overstay_needs_review",
            "created_at",
        ]
        read_only_fields = fields

    @extend_schema_field(
        serializers.ChoiceField(choices=["none", "pending", "done", "manual", "failed"])
    )
    def get_refund_status(self, obj) -> str:
        return refund_status_for(obj)


class AdminBookingDetailSerializer(AdminBookingSerializer):
    events = BookingEventSerializer(many=True, read_only=True)
    payments = AdminPaymentSerializer(many=True, read_only=True)
    refunds = AdminRefundSerializer(many=True, read_only=True)

    class Meta(AdminBookingSerializer.Meta):
        fields = [*AdminBookingSerializer.Meta.fields, "events", "payments", "refunds"]
        read_only_fields = fields


class PagedAdminBookingSerializer(PageSerializer):
    results = AdminBookingSerializer(many=True)


class PagedAdminPaymentSerializer(PageSerializer):
    results = AdminPaymentSerializer(many=True)


class PagedAdminRefundSerializer(PageSerializer):
    results = AdminRefundSerializer(many=True)


def clean_operator_note(value: str) -> str:
    """Same rule as the service / command: <= 200 characters, no phone or card number."""
    try:
        return clean_note(value)
    except ValueError as exc:
        raise serializers.ValidationError(str(exc)) from exc


class BookingCancelSerializer(StrictSerializer):
    reason = serializers.CharField(
        max_length=OPERATOR_NOTE_LENGTH, required=False, allow_blank=True, default=""
    )

    def validate_reason(self, value: str) -> str:
        return clean_operator_note(value)


class RefundResolveSerializer(StrictSerializer):
    outcome = serializers.ChoiceField(choices=["done", "retry", "failed"])
    note = serializers.CharField(
        max_length=OPERATOR_NOTE_LENGTH, required=False, allow_blank=True, default=""
    )

    def validate_note(self, value: str) -> str:
        return clean_operator_note(value)


# --- settings, audit, stats -----------------------------------------------------------------------


def _setting_field(low: int, high: int) -> serializers.IntegerField:
    return serializers.IntegerField(min_value=low, max_value=high)


class SettingsSerializer(StrictSerializer):
    """GET shape; ranges are the same as in ``bookings.conf.EDITABLE_SETTINGS``."""

    hold_minutes = _setting_field(*EDITABLE_SETTINGS["hold_minutes"][1:])
    no_show_grace_minutes = _setting_field(*EDITABLE_SETTINGS["no_show_grace_minutes"][1:])
    cancel_full_refund_minutes = _setting_field(
        *EDITABLE_SETTINGS["cancel_full_refund_minutes"][1:]
    )
    cancel_full_percent = _setting_field(*EDITABLE_SETTINGS["cancel_full_percent"][1:])
    cancel_late_percent = _setting_field(*EDITABLE_SETTINGS["cancel_late_percent"][1:])
    cancel_after_start_percent = _setting_field(
        *EDITABLE_SETTINGS["cancel_after_start_percent"][1:]
    )


class SettingsUpdateSerializer(SettingsSerializer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for field in self.fields.values():
            field.required = False

    def validate(self, attrs):
        if not attrs:
            raise serializers.ValidationError("Send at least one setting.")
        return attrs


class AuditLogSerializer(serializers.ModelSerializer):
    actor = serializers.PrimaryKeyRelatedField(read_only=True, allow_null=True)
    meta = serializers.JSONField(read_only=True)

    class Meta:
        model = AuditLog
        fields = ["id", "created_at", "actor", "action", "target_type", "target_id", "meta"]
        read_only_fields = fields


class PagedAuditLogSerializer(PageSerializer):
    results = AuditLogSerializer(many=True)


class StatsQuerySerializer(serializers.Serializer):
    parking_lot = serializers.UUIDField(required=False)


class RevenueQuerySerializer(StatsQuerySerializer):
    # NB: ``from`` is a keyword, so the view reads it from ``query_params`` and validates here.
    # a value without an offset is read as Asia/Tashkent, like the list filters
    start = serializers.DateTimeField(required=False)
    end = serializers.DateTimeField(required=False)


class StatsOverviewSerializer(serializers.Serializer):
    bookings_today = serializers.IntegerField()
    bookings_active = serializers.IntegerField()
    revenue_today = serializers.CharField()
    revenue_month = serializers.CharField()
    occupancy_percent = serializers.CharField()
    total_slots = serializers.IntegerField()
    occupied_slots = serializers.IntegerField()
    lots_pending_review = serializers.IntegerField()
    refunds_needing_attention = serializers.IntegerField()
    overstay_due = serializers.IntegerField()


class RevenuePointSerializer(serializers.Serializer):
    date = serializers.CharField()
    revenue = serializers.CharField()
    bookings = serializers.IntegerField()


class RevenueStatsSerializer(serializers.Serializer):
    results = RevenuePointSerializer(many=True)


class OccupancyRowSerializer(serializers.Serializer):
    parking_lot = AdminLotRefSerializer()
    total_slots = serializers.IntegerField()
    occupied_slots = serializers.IntegerField()
    occupancy_percent = serializers.CharField()


class OccupancyStatsSerializer(serializers.Serializer):
    results = OccupancyRowSerializer(many=True)
