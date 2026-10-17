from decimal import Decimal

from django.conf import settings
from django.contrib.postgres.indexes import GistIndex
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models

from apps.core.geo import PointField, PolygonField
from apps.core.models import BaseModel

from .validators import MAX_DISTANCE_TO_ENTRANCE


class LotStatus(models.TextChoices):
    PENDING_REVIEW = "PENDING_REVIEW", "Pending review"
    ACTIVE = "ACTIVE", "Active"
    SUSPENDED = "SUSPENDED", "Suspended"


class SlotType(models.TextChoices):
    STANDARD = "STANDARD", "Standard"
    EV = "EV", "EV charging"
    DISABLED = "DISABLED", "Disabled"
    LARGE = "LARGE", "Large"


class SlotStatus(models.TextChoices):
    FREE = "FREE", "Free"
    RESERVED = "RESERVED", "Reserved"
    OCCUPIED = "OCCUPIED", "Occupied"
    OUT_OF_SERVICE = "OUT_OF_SERVICE", "Out of service"


class ParkingLot(BaseModel):
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="parking_lots"
    )
    name = models.CharField(max_length=200)
    address = models.CharField(max_length=300)
    # geography(Point,4326); the GiST index is declared explicitly in Meta.indexes (ARCH 7.1).
    location = PointField(geography=True, srid=4326, spatial_index=False)
    area = PolygonField(srid=4326, null=True, blank=True)
    status = models.CharField(
        max_length=20, choices=LotStatus.choices, default=LotStatus.PENDING_REVIEW
    )
    open_time = models.TimeField(null=True, blank=True)
    close_time = models.TimeField(null=True, blank=True)
    # Denormalized counters, maintained by services.recalculate_counters / reconcile task.
    total_slots = models.PositiveIntegerField(default=0)
    free_slots = models.PositiveIntegerField(default=0)
    rating = models.FloatField(default=0)
    # When true, the operator must type the plate of the car at check-in (it is compared with the
    # booking): a screenshot of somebody else's QR then cannot admit another car on its own.
    require_plate_on_checkin = models.BooleanField(default=False)

    class Meta:
        db_table = "parking_lot"
        ordering = ["-created_at", "id"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(free_slots__lte=models.F("total_slots")),
                name="parking_lot_free_lte_total",
            ),
            # open == close would be a zero-length interval: 24/7 is expressed as NULL/NULL.
            # (NULL comparisons are "unknown", which a CHECK accepts.)
            models.CheckConstraint(
                condition=~models.Q(open_time=models.F("close_time")),
                name="parking_lot_hours_not_zero_length",
            ),
            # Both set or both NULL: a lot with only an opening (or only a closing) time has no
            # defined schedule, and bookings must not guess (it would read as 24/7).
            models.CheckConstraint(
                condition=models.Q(open_time__isnull=True, close_time__isnull=True)
                | models.Q(open_time__isnull=False, close_time__isnull=False),
                name="parking_lot_hours_both_or_none",
            ),
        ]
        indexes = [
            GistIndex(fields=["location"], name="parking_lot_location_gist"),
            # Nearby search only ever reads ACTIVE lots: a partial index keeps the KNN scan from
            # walking PENDING/SUSPENDED entries in sparse areas. free_slots must NOT be in the
            # predicate: it is a hot counter and would defeat HOT updates (index bloat).
            GistIndex(
                fields=["location"],
                condition=models.Q(status="ACTIVE"),
                name="parking_lot_loc_active_gist",
            ),
            models.Index(fields=["owner", "status"], name="parking_lot_owner_status"),
        ]

    def __str__(self) -> str:
        return self.name


class Zone(BaseModel):
    parking_lot = models.ForeignKey(ParkingLot, on_delete=models.CASCADE, related_name="zones")
    name = models.CharField(max_length=100)
    floor = models.IntegerField(default=0)

    class Meta:
        ordering = ["floor", "name", "id"]
        constraints = [
            models.UniqueConstraint(fields=["parking_lot", "name"], name="zone_unique_name_in_lot")
        ]

    def __str__(self) -> str:
        return self.name


class Slot(BaseModel):
    zone = models.ForeignKey(Zone, on_delete=models.CASCADE, related_name="slots")
    code = models.CharField(max_length=20)
    type = models.CharField(max_length=10, choices=SlotType.choices, default=SlotType.STANDARD)
    status = models.CharField(max_length=20, choices=SlotStatus.choices, default=SlotStatus.FREE)
    distance_to_entrance = models.PositiveIntegerField(
        default=0, validators=[MaxValueValidator(MAX_DISTANCE_TO_ENTRANCE)], help_text="metres"
    )

    class Meta:
        ordering = ["distance_to_entrance", "code", "id"]
        constraints = [
            models.UniqueConstraint(fields=["zone", "code"], name="slot_unique_code_in_zone")
        ]
        indexes = [models.Index(fields=["zone", "status", "type"], name="slot_zone_status_type")]

    def __str__(self) -> str:
        return self.code


class OperatorAssignment(BaseModel):
    """A staff member (role OPERATOR) who may run one lot's gate: scan QR codes, walk-ins, slot
    states (ARCHITECTURE 6.3, 7). Never deleted: a revoked row keeps who was allowed when."""

    operator = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="operator_assignments"
    )
    # PROTECT like every other record that points at a lot: a lot with staff history is not
    # deleted silently (parking.services answers 409; revoke the staff first).
    parking_lot = models.ForeignKey(
        ParkingLot, on_delete=models.PROTECT, related_name="operator_assignments"
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    revoked_at = models.DateTimeField(null=True, blank=True)  # NULL = active
    revoked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )

    class Meta:
        ordering = ["created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["operator", "parking_lot"],
                condition=models.Q(revoked_at__isnull=True),
                name="operator_assignment_unique_active",
            )
        ]
        indexes = [
            # "who works in this lot now": a tiny index of the active rows only
            models.Index(
                fields=["parking_lot"],
                condition=models.Q(revoked_at__isnull=True),
                name="opassign_lot_active",
            )
        ]

    @property
    def is_active(self) -> bool:
        return self.revoked_at is None

    def __str__(self) -> str:
        return f"OperatorAssignment({self.operator_id} -> {self.parking_lot_id})"


class OperatorInvite(BaseModel):
    """A one-time code that lets a registered user become an operator of one lot.

    Replaces looking people up by phone / username (that harvested personal data and assigned
    people without their consent): the owner creates an invite, hands the code to the staff
    member, and the staff member accepts it from their OWN account. Only ``sha256(code)`` is
    stored; the code itself is shown once, when the invite is created.
    """

    parking_lot = models.ForeignKey(
        ParkingLot, on_delete=models.PROTECT, related_name="operator_invites"
    )
    token_hash = models.CharField(max_length=64, unique=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="+"
    )
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    used_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at", "id"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(used_at__isnull=True) | models.Q(used_by__isnull=False),
                name="operator_invite_used_has_user",
            ),
            models.CheckConstraint(
                condition=models.Q(used_at__isnull=True) | models.Q(revoked_at__isnull=True),
                name="operator_invite_not_used_and_revoked",
            ),
        ]
        indexes = [
            models.Index(
                fields=["parking_lot", "expires_at"],
                condition=models.Q(used_at__isnull=True, revoked_at__isnull=True),
                name="opinvite_lot_open",
            )
        ]

    def __str__(self) -> str:
        return f"OperatorInvite({self.parking_lot_id})"


class Tariff(BaseModel):
    parking_lot = models.ForeignKey(ParkingLot, on_delete=models.CASCADE, related_name="tariffs")
    slot_type = models.CharField(max_length=10, choices=SlotType.choices)
    price_per_hour = models.DecimalField(
        max_digits=12, decimal_places=2, validators=[MinValueValidator(Decimal("0"))]
    )
    # Time/day coefficients; shape validated by apps.parking.validators.validate_tariff_rules.
    rules = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ["slot_type", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["parking_lot", "slot_type"], name="tariff_unique_type_in_lot"
            ),
            models.CheckConstraint(
                condition=models.Q(price_per_hour__gte=0), name="tariff_price_non_negative"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.slot_type} {self.price_per_hour}"
