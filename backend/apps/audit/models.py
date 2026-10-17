from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import models

from apps.core.models import BaseModel

_PURGE_ALLOWED: ContextVar[bool] = ContextVar("audit_purge_allowed", default=False)


class AuditImmutable(ImproperlyConfigured):
    """Attempt to change or delete an audit row outside the retention purge."""


@contextmanager
def purge_allowed() -> Iterator[None]:
    """Open the model-level guard for the retention purge (``apps.audit.services.purge``) only."""
    token = _PURGE_ALLOWED.set(True)
    try:
        yield
    finally:
        _PURGE_ALLOWED.reset(token)


class AuditQuerySet(models.QuerySet):
    def update(self, **kwargs):
        raise AuditImmutable("AuditLog rows are append-only.")

    def bulk_update(self, objs, fields, batch_size=None):
        raise AuditImmutable("AuditLog rows are append-only.")

    def delete(self):
        if not _PURGE_ALLOWED.get():
            raise AuditImmutable("AuditLog rows are deleted only by the retention purge.")
        return super().delete()


class AuditLog(BaseModel):
    """One important action (ARCHITECTURE 15 "Audit"): who, what, on which object.

    Written by ``apps.parking.services.audit`` INSIDE the caller's transaction (a rolled-back change
    leaves no row; a committed one cannot lose its row). APPEND-ONLY: the model refuses ``save()``
    of an existing row, ``delete()``, ``update()`` and ``delete()`` of a queryset; the single way
    rows disappear is ``apps.audit.services.purge`` (retention). On PostgreSQL a trigger enforces
    the same in the database (migration ``0002``): updates are refused except the
    ``SET NULL`` of ``actor`` when an account is deleted, deletes only while the purge has set
    ``habi.audit_purge``.

    ``meta`` holds ``{"before": ..., "after": ...}`` filtered by the ``audit.scrub`` ALLOWLIST: no
    phone, name, username, QR token or nonce, plates only as a keyed hash hint. An admin view is
    Step 11.
    """

    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
        help_text="NULL = the system (Celery) or a deleted account.",
    )
    action = models.CharField(max_length=64)
    target_type = models.CharField(max_length=32, blank=True)
    target_id = models.CharField(max_length=64, blank=True)
    meta = models.JSONField(default=dict, blank=True)

    objects = AuditQuerySet.as_manager()

    class Meta:
        ordering = ["-created_at", "id"]
        indexes = [
            models.Index(fields=["created_at"], name="auditlog_created"),
            models.Index(fields=["action", "created_at"], name="auditlog_action_created"),
            models.Index(fields=["target_type", "target_id"], name="auditlog_target"),
        ]

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise AuditImmutable("AuditLog rows are append-only.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise AuditImmutable("AuditLog rows are deleted only by the retention purge.")

    def __str__(self) -> str:
        return f"{self.action} {self.target_type}:{self.target_id}"
