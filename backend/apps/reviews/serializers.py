from rest_framework import serializers

from .models import COMMENT_MAX_LENGTH, RATING_MAX, RATING_MIN, Review, ReviewStatus


class ReviewCreateSerializer(serializers.Serializer):
    booking_id = serializers.UUIDField()
    rating = serializers.IntegerField(min_value=RATING_MIN, max_value=RATING_MAX)
    comment = serializers.CharField(
        max_length=COMMENT_MAX_LENGTH,
        allow_blank=True,
        required=False,
        default="",
        trim_whitespace=True,
    )


class PublicReviewSerializer(serializers.ModelSerializer):
    """What other drivers see: no author, no booking."""

    class Meta:
        model = Review
        fields = ["id", "rating", "comment", "created_at"]
        read_only_fields = fields


class PagedPublicReviewSerializer(serializers.Serializer):
    count = serializers.IntegerField()
    next = serializers.URLField(allow_null=True)
    previous = serializers.URLField(allow_null=True)
    results = PublicReviewSerializer(many=True)


class ReviewLotRefSerializer(serializers.Serializer):
    id = serializers.UUIDField()
    name = serializers.CharField()


class AdminReviewSerializer(serializers.ModelSerializer):
    parking_lot = ReviewLotRefSerializer(read_only=True)
    comment = serializers.CharField(read_only=True)
    status = serializers.ChoiceField(choices=ReviewStatus.choices, read_only=True)

    class Meta:
        model = Review
        fields = ["id", "parking_lot", "rating", "comment", "status", "created_at"]
        read_only_fields = fields


class PagedAdminReviewSerializer(serializers.Serializer):
    count = serializers.IntegerField()
    next = serializers.URLField(allow_null=True)
    previous = serializers.URLField(allow_null=True)
    results = AdminReviewSerializer(many=True)
