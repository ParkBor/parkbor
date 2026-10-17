import logging

from django.core.exceptions import ObjectDoesNotExist
from django.db import IntegrityError
from redis.exceptions import RedisError
from rest_framework.views import exception_handler

from apps.core.exceptions import Conflict, NotFoundError, ServiceUnavailableError

logger = logging.getLogger(__name__)


def api_exception_handler(exc, context):
    """DRF handler that maps low-level failures to clean {detail, code} responses.

    * Redis outage -> 503;
    * IntegrityError / ProtectedError (a subclass) that no service translated, e.g. a race ->
      409 Conflict;
    * DoesNotExist raised inside a service (row deleted in parallel) -> 404.

    Only the exception TYPE is logged and nothing from its message is returned: database
    messages contain table, constraint and value names.
    """
    if isinstance(exc, RedisError):
        logger.error("redis unavailable: %s", type(exc).__name__)
        exc = ServiceUnavailableError()
    elif isinstance(exc, IntegrityError):  # includes ProtectedError
        logger.warning("integrity conflict: %s", type(exc).__name__)
        exc = Conflict("The request conflicts with existing data.")
    elif isinstance(exc, ObjectDoesNotExist):
        logger.warning("object vanished: %s", type(exc).__name__)
        exc = NotFoundError()
    return exception_handler(exc, context)
