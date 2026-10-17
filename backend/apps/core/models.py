import uuid

from django.db import models


class BaseModel(models.Model):
    """Abstract base: UUID primary key and creation timestamp (UTC in DB)."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True
