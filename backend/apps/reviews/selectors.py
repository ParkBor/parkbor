"""Read queries of the reviews app."""

from django.db.models import QuerySet

from apps.core.permissions import is_owner, is_super_admin

from .models import Review, ReviewStatus


def published_for_lot(lot_id) -> QuerySet[Review]:
    return Review.objects.filter(parking_lot_id=lot_id, status=ReviewStatus.PUBLISHED).order_by(
        "-created_at", "id"
    )


def reviews_for_staff(user) -> QuerySet[Review]:
    """ADMIN: all reviews. OWNER: reviews of own lots. Anyone else: none."""
    queryset = Review.objects.select_related("parking_lot")
    if is_super_admin(user):
        return queryset
    if is_owner(user):
        return queryset.filter(parking_lot__owner_id=user.pk)
    return queryset.none()
