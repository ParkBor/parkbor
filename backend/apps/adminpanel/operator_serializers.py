"""Staff management serializers (owner/admin API: ``/admin/parkings/{id}/operators`` and
``/admin/parkings/{id}/operator-invites``). Minimal personal data by design."""

from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from apps.core.permissions import is_owner
from apps.parking.models import OperatorAssignment, OperatorInvite


class InviteCreateSerializer(serializers.Serializer):
    expires_in_hours = serializers.IntegerField(
        required=False,
        min_value=1,
        max_value=168,
        help_text="Life of the code in hours (default 72).",
    )


class InviteCreatedSerializer(serializers.Serializer):
    invite_id = serializers.UUIDField()
    code = serializers.CharField(
        help_text="Shown ONCE. Give it to the staff member; it cannot be read back."
    )
    expires_at = serializers.DateTimeField()


class InviteSerializer(serializers.ModelSerializer):
    """An open invitation. The code is never included (only its hash is stored)."""

    class Meta:
        model = OperatorInvite
        fields = ["id", "created_at", "expires_at"]
        read_only_fields = fields


class PagedInviteSerializer(serializers.Serializer):
    count = serializers.IntegerField()
    next = serializers.URLField(allow_null=True)
    previous = serializers.URLField(allow_null=True)
    results = InviteSerializer(many=True)


def masked_name(user) -> str:
    """ "Aziza K." : first name and the initial of the last one, nothing else."""
    first = (user.first_name or "").strip()
    last = (user.last_name or "").strip()
    return f"{first} {last[0]}.".strip() if last else first


class OperatorAssignmentSerializer(serializers.ModelSerializer):
    """Who works in the lot: ids, a masked display name (OWNER only) and the date. Never a phone
    number or a Telegram username."""

    assignment_id = serializers.UUIDField(source="id", read_only=True)
    id = serializers.UUIDField(source="operator_id", read_only=True)
    display_name = serializers.SerializerMethodField(
        help_text="First name + initial of the last name; null for administrators' requests."
    )

    class Meta:
        model = OperatorAssignment
        fields = ["id", "assignment_id", "display_name", "created_at"]
        read_only_fields = fields

    @extend_schema_field(serializers.CharField(allow_null=True))
    def get_display_name(self, obj) -> str | None:
        request = self.context.get("request")
        if request is None or not is_owner(request.user):
            return None
        return masked_name(obj.operator)


class PagedOperatorAssignmentSerializer(serializers.Serializer):
    count = serializers.IntegerField()
    next = serializers.URLField(allow_null=True)
    previous = serializers.URLField(allow_null=True)
    results = OperatorAssignmentSerializer(many=True)
