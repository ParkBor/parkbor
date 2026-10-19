"""Review writes. Lot rating = average of PUBLISHED ratings (2 decimals), 0 = no reviews."""

from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import Avg
from django.utils import timezone

from apps.bookings import services as booking_services
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus
from apps.core.exceptions import Conflict, NotFoundError
from apps.parking.models import LotStatus, ParkingLot
from apps.parking.services import audit, lock_lot

from .models import Review, ReviewStatus

RATING_DECIMALS = Decimal("0.01")


class NotReviewable(Conflict):
    default_detail = "Only a completed, paid booking of this parking lot can be reviewed."
    default_code = "booking_not_reviewable"


class AlreadyReviewed(Conflict):
    default_detail = "This booking has already been reviewed."
    default_code = "already_reviewed"


def recalculate_rating(lot_id) -> None:
    """Caller holds the lot lock, so two concurrent reviews cannot lose an update."""
    average = Review.objects.filter(parking_lot_id=lot_id, status=ReviewStatus.PUBLISHED).aggregate(
        avg=Avg("rating")
    )["avg"]
    rating = 0.0 if average is None else float(Decimal(str(average)).quantize(RATING_DECIMALS))
    ParkingLot.objects.filter(pk=lot_id).update(rating=rating)


@booking_services.retrying
@transaction.atomic
def create_review(*, user, lot_id, booking_id, rating: int, comment: str) -> Review:
    """A driver reviews a COMPLETED booking of his own in this lot (once per booking)."""
    booking_services.set_local_timeouts(5)
    lot = lock_lot(lot_id)
    if lot.status != LotStatus.ACTIVE:
        raise NotFoundError("Parking lot not found.")  # only listed lots take reviews
    booking = (
        Booking.objects.filter(pk=booking_id, user=user, slot__zone__parking_lot_id=lot_id)
        .select_related("slot__zone")
        .first()
    )
    if booking is None:
        raise NotFoundError("Booking not found.")
    if booking.status != BookingStatus.COMPLETED or booking.paid_amount <= 0:
        raise NotReviewable  # an unpaid / free stay is not a verified customer
    try:
        with transaction.atomic():
            review = Review.objects.create(
                parking_lot_id=lot_id,
                user=user,
                booking=booking,
                rating=rating,
                comment=comment,
            )
    except IntegrityError as exc:
        raise AlreadyReviewed from exc
    recalculate_rating(lot_id)
    return review


@booking_services.retrying
@transaction.atomic
def set_status(*, review_id, actor, status: str) -> Review:
    """Moderation (ADMIN): hide or publish. Idempotent; the lot rating follows."""
    lot_id = Review.objects.filter(pk=review_id).values_list("parking_lot_id", flat=True).first()
    if lot_id is None:
        raise NotFoundError("Review not found.")
    booking_services.set_local_timeouts(5)
    lock_lot(lot_id)
    review = Review.objects.select_for_update(of=("self",)).get(pk=review_id)
    if review.status == status:
        return review
    before = review.status
    review.status = status
    review.moderated_by = actor
    review.moderated_at = timezone.now()
    review.save(update_fields=["status", "moderated_by", "moderated_at"])
    recalculate_rating(lot_id)
    audit(
        actor=actor,
        action="review.hide" if status == ReviewStatus.HIDDEN else "review.publish",
        obj_id=review.pk,
        before={"status": before},
        after={"status": status, "lot": str(lot_id)},
    )
    return review
