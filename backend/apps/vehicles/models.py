from django.conf import settings
from django.db import models

from apps.core.models import BaseModel


class VehicleType(models.TextChoices):
    CAR = "CAR", "Car"
    TRUCK = "TRUCK", "Truck"
    EV = "EV", "Electric vehicle"
    DISABLED = "DISABLED", "Disabled driver"


class Vehicle(BaseModel):
    """A driver's car. The type (EV, DISABLED, ...) is SELF-DECLARED: nothing verifies it, so the
    special-slot rule (bookings.compat) is a convenience, not an entitlement check."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="vehicles"
    )
    # Stored normalised (upper case, no spaces): apps.vehicles.plate.normalize_plate.
    plate_number = models.CharField(max_length=12)
    type = models.CharField(max_length=10, choices=VehicleType.choices, default=VehicleType.CAR)
    # Soft delete: a vehicle with booking history is archived instead of removed. Archived
    # vehicles are invisible, do not count towards the limit and free their plate number.
    is_archived = models.BooleanField(default=False)

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "plate_number"],
                condition=models.Q(is_archived=False),
                name="vehicle_unique_plate_per_user",
            )
        ]

    def __str__(self) -> str:
        return self.plate_number
