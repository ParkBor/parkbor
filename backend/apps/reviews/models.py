"""Driver reviews of parking lots (ARCHITECTURE 9.1 ``POST /parkings/{id}/reviews``, 9.3.2)."""

from django.conf import settings
from django.db import models
from django.db.models import Q

from apps.core.models import BaseModel

RATING_MIN, RATING_MAX = 1, 5
COMMENT_MAX_LENGTH = 1000


class ReviewStatus(models.TextChoices):
    PUBLISHED = "PUBLISHED", "Published"
    HIDDEN = "HIDDEN", "Hidden by a moderator"


class Review(BaseModel):
    """One review per COMPLETED booking. The author is stored (to enforce the rules and let an
    administrator act on abuse) but never exposed by any API."""

    parking_lot = models.ForeignKey(
        "parking.ParkingLot", on_delete=models.PROTECT, related_name="reviews"
    )
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+")
    booking = models.OneToOneField(
        "bookings.Booking", on_delete=models.PROTECT, related_name="review"
    )
    rating = models.PositiveSmallIntegerField()
    comment = models.CharField(max_length=COMMENT_MAX_LENGTH, blank=True)
    status = models.CharField(
        max_length=10, choices=ReviewStatus.choices, default=ReviewStatus.PUBLISHED
    )
    moderated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name="+"
    )
    moderated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "id"]
        constraints = [
            models.CheckConstraint(
                condition=Q(rating__gte=RATING_MIN) & Q(rating__lte=RATING_MAX),
                name="review_rating_1_5",
            ),
            models.CheckConstraint(
                condition=Q(status__in=ReviewStatus.values), name="review_status_valid"
            ),
        ]
        indexes = [
            models.Index(fields=["parking_lot", "status", "-created_at"], name="review_lot_list"),
            models.Index(fields=["status", "-created_at"], name="review_status_list"),
        ]

    def __str__(self) -> str:
        return f"Review({self.pk}, {self.rating}, {self.status})"
