from rest_framework import serializers

from .models import Vehicle, VehicleType
from .plate import InvalidPlate, normalize_plate


class VehicleSerializer(serializers.ModelSerializer):
    plate_number = serializers.CharField(
        max_length=32,  # raw input; the stored (normalised) form is at most 12 characters
        help_text="Any spacing/case; stored upper-case without spaces, e.g. 01A123BC.",
    )
    type = serializers.ChoiceField(choices=VehicleType.choices, default=VehicleType.CAR)

    class Meta:
        model = Vehicle
        fields = ["id", "plate_number", "type", "created_at"]
        read_only_fields = ["id", "created_at"]

    def validate(self, attrs):
        # POST may omit the type (defaults to CAR); a full replacement (PUT) must state it, or
        # an omitted field would silently turn an EV into a CAR.
        replacing = self.instance is not None and not self.partial
        if replacing and "type" not in self.initial_data:
            raise serializers.ValidationError({"type": ["This field is required."]})
        return attrs

    def validate_plate_number(self, value: str) -> str:
        try:
            return normalize_plate(value)
        except InvalidPlate as exc:
            raise serializers.ValidationError(str(exc)) from exc
