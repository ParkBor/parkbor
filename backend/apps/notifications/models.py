from django.conf import settings
from django.db import models

from apps.core.models import BaseModel


class NotificationLog(BaseModel):
    """One notification to one user for one fact. The UNIQUE key is what makes the sending
    idempotent: a repeated hook, a sweep run twice or a retried task can never message the same
    user about the same fact twice.

    ``context`` holds only what the template needs (booking id, slot code, amount); never a
    plate, phone or name. ``last_error`` is a short machine code, never a URL, token or body.
    """

    class Status(models.TextChoices):
        PENDING = "PENDING", "Pending"
        SENT = "SENT", "Sent"
        FAILED = "FAILED", "Failed"
        SKIPPED = "SKIPPED", "Skipped"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notification_logs"
    )
    event = models.CharField(max_length=32)
    # What the fact is about: a booking id, a refund id. Part of the uniqueness.
    dedupe_key = models.CharField(max_length=80)
    context = models.JSONField(default=dict, blank=True)
    # Channels tried by the last attempt ("push", "telegram", "push+telegram") and the ones that
    # actually delivered (a retry only goes to the channels that have not delivered yet).
    channel = models.CharField(max_length=24, blank=True)
    delivered = models.CharField(max_length=24, blank=True)
    status = models.CharField(max_length=8, choices=Status.choices, default=Status.PENDING)
    attempts = models.PositiveSmallIntegerField(default=0)
    last_error = models.CharField(max_length=120, blank=True)
    # When the next attempt is due (set with a retry, honouring Retry-After). resend_pending never
    # re-queues a row before this moment, so it cannot defeat the backoff.
    next_attempt_at = models.DateTimeField(null=True, blank=True)
    # A worker that claimed the row owns it until then (stops two workers sending the same one).
    lease_until = models.DateTimeField(null=True, blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "notification_log"
        ordering = ["-created_at", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "event", "dedupe_key"], name="notification_once_per_fact"
            ),
            models.CheckConstraint(
                condition=models.Q(status__in=["PENDING", "SENT", "FAILED", "SKIPPED"]),
                name="notification_status_valid",
            ),
        ]
        indexes = [
            # the only status resend_pending scans: a small partial index instead of a big one
            models.Index(
                fields=["updated_at"],
                condition=models.Q(status="PENDING"),
                name="notification_pending_updated",
            ),
            models.Index(fields=["status", "created_at"], name="notification_status_created"),
            models.Index(fields=["created_at"], name="notification_created"),
        ]

    def __str__(self) -> str:
        return f"NotificationLog({self.event}, {self.status})"
