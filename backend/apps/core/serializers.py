from rest_framework import serializers


class ErrorSerializer(serializers.Serializer):
    """Shape of ApiError responses (documentation only)."""

    detail = serializers.CharField()
    code = serializers.CharField()


def error_responses(*codes: int) -> dict:
    """``responses=`` entries for the given HTTP error codes (drf-spectacular)."""
    return {code: ErrorSerializer for code in codes}
