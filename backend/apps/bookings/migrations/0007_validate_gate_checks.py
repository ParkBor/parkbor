from django.db import migrations

from apps.bookings.migration_ops import ValidateCheckConstraint


class Migration(migrations.Migration):
    """Validate the CHECK constraints added NOT VALID by 0005. Non-atomic on purpose: each
    ``VALIDATE CONSTRAINT`` is its own short statement, so no long transaction holds locks."""

    atomic = False

    dependencies = [("bookings", "0006_overstay_needs_review")]

    operations = [
        ValidateCheckConstraint("booking", "booking_online_has_user_vehicle"),
        ValidateCheckConstraint("booking", "booking_kind_valid"),
        ValidateCheckConstraint("booking", "booking_overstay_valid"),
    ]
