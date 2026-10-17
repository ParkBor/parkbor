"""Staff management (ARCHITECTURE 2, 6.3, 9.3).

Becoming an operator is a CONSENSUAL, code-based flow (no lookup of people by phone / username):

1. the lot's owner (or an admin) creates an invitation: ``create_invite`` -> a one-time code,
   shown once (only ``sha256(code)`` is stored), valid ``OPERATOR_INVITE_HOURS``;
2. the staff member, signed in to their OWN account, sends the code: ``accept_invite``. The
   invite is spent atomically (``UPDATE ... WHERE used_at IS NULL``), the account becomes an
   OPERATOR of that lot (a DRIVER is promoted; OWNER / ADMIN are never changed);
3. every refusal of step 2 (wrong, expired, used, revoked code; lot not ACTIVE; OWNER / ADMIN
   account) is ONE and the same ``400 invite_invalid``, so nobody can tell codes apart, and an
   account that keeps failing is locked out of trying for a while.

Revoking the last assignment of an OPERATOR returns the account to DRIVER. Lock order, as
everywhere: lot first, then the user row. Every write is wrapped by ``retrying`` (deadlock retry
once, lock wait -> 503) with a bounded lock wait.
"""

import base64
import hashlib
import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.accounts.models import User
from apps.bookings import services as booking_services
from apps.bookings.conf import get_config
from apps.core.attempts import FailureCounter
from apps.core.exceptions import ApiError, Conflict, DomainValidationError, NotFoundError
from apps.parking.models import LotStatus, OperatorAssignment, OperatorInvite, ParkingLot
from apps.parking.services import audit, lock_lot

from . import selectors

logger = logging.getLogger(__name__)

CODE_BYTES = 16  # 128 bits -> 26 base32 characters
_CODE_PATTERN = re.compile(r"^[A-Z2-7]{26}$")
_GROUP = 5


class InviteInvalid(DomainValidationError):
    """The one answer to every unusable code: it must not reveal WHY."""

    default_detail = "This invitation code is not valid."
    default_code = "invite_invalid"


class InviteLimitReached(Conflict):
    default_detail = "Too many open invitations for this lot. Revoke one first."
    default_code = "invite_limit_reached"


class InviteLocked(ApiError):
    status_code = 429
    default_detail = "Too many wrong codes. Try again later."
    default_code = "invite_locked"


def _failures() -> FailureCounter:
    return FailureCounter(
        "invitefail",
        settings.OPERATOR_INVITE_FAIL_LIMIT,
        settings.OPERATOR_INVITE_FAIL_WINDOW_SECONDS,
    )


def normalize_code(raw) -> str:
    """Upper case, no spaces or dashes; "" if it cannot be a code."""
    compact = re.sub(r"[\s-]", "", str(raw or "")).upper()
    return compact if _CODE_PATTERN.fullmatch(compact) else ""


def hash_code(normalized: str) -> str:
    return hashlib.sha256(normalized.encode("ascii")).hexdigest()


def format_code(normalized: str) -> str:
    return "-".join(normalized[i : i + _GROUP] for i in range(0, len(normalized), _GROUP))


def _bounded_lock_wait() -> None:
    booking_services.set_local_timeouts(get_config().lock_timeout_seconds)


# --- invitations (owner / admin side) ------------------------------------------------------------


@booking_services.retrying
@transaction.atomic
def create_invite(
    *, lot: ParkingLot, actor, hours: int | None = None, now: datetime | None = None
) -> tuple[OperatorInvite, str]:
    """(invite, code). The code is returned ONLY here; it cannot be read back later."""
    now = now or timezone.now()
    _bounded_lock_wait()
    lock_lot(lot.pk)
    if selectors.open_invites(lot, now).count() >= settings.OPERATOR_INVITE_MAX_OPEN:
        raise InviteLimitReached
    normalized = base64.b32encode(secrets.token_bytes(CODE_BYTES)).decode("ascii").rstrip("=")
    invite = OperatorInvite.objects.create(
        parking_lot=lot,
        token_hash=hash_code(normalized),
        created_by=actor,
        expires_at=now + timedelta(hours=hours or settings.OPERATOR_INVITE_HOURS),
    )
    audit(
        actor=actor,
        action="operator.invite_create",
        obj_id=invite.pk,
        before={},
        after={"lot": str(lot.pk), "expires_at": invite.expires_at.isoformat()},
    )
    return invite, format_code(normalized)


@booking_services.retrying
@transaction.atomic
def revoke_invite(*, lot: ParkingLot, invite_id, actor, now: datetime | None = None) -> None:
    """Cancel an open invitation (idempotent; a used one stays as it is)."""
    now = now or timezone.now()
    try:
        invite_uuid = uuid.UUID(str(invite_id))
    except ValueError as exc:
        raise NotFoundError("Invitation not found.") from exc
    _bounded_lock_wait()
    lock_lot(lot.pk)
    invite = OperatorInvite.objects.filter(pk=invite_uuid, parking_lot=lot).first()
    if invite is None:
        raise NotFoundError("Invitation not found.")
    if invite.used_at is not None or invite.revoked_at is not None:
        return
    invite.revoked_at = now
    invite.save(update_fields=["revoked_at"])
    audit(actor=actor, action="operator.invite_revoke", obj_id=invite.pk, before={}, after={})


# --- accepting (the staff member's own account) --------------------------------------------------


def accept_invite(*, user, code, now: datetime | None = None) -> ParkingLot:
    """Use a code from the caller's own account. Raises ``InviteInvalid`` (400) for ANY reason a
    code cannot be used, ``InviteLocked`` (429) after too many wrong codes."""
    counter, key = _failures(), str(user.pk)
    remaining = counter.seconds_locked(key)
    if remaining:
        error = InviteLocked()
        error.wait = remaining
        raise error
    try:
        return _accept(user, code, now or timezone.now())
    except InviteInvalid:
        failures = counter.record(key)
        if failures >= settings.OPERATOR_INVITE_FAIL_LIMIT and counter.first_time_locked(key):
            _audit_lockout(user)
        raise


def _audit_lockout(user) -> None:
    """Fail-open: a broken audit table must not replace the 400 the caller is about to get."""
    try:
        audit(
            actor=user,
            action="operator.invite_locked",
            obj_id=user.pk,
            before={},
            after={"window_seconds": settings.OPERATOR_INVITE_FAIL_WINDOW_SECONDS},
        )
    except Exception:  # noqa: BLE001
        logger.exception("could not audit the invitation lock-out")


def _find_invite(normalized: str):
    if not normalized:
        return None
    return (
        OperatorInvite.objects.filter(token_hash=hash_code(normalized))
        .values("pk", "parking_lot_id", "created_by_id")
        .first()
    )


@booking_services.retrying
@transaction.atomic
def _accept(user, code, now: datetime) -> ParkingLot:
    row = _find_invite(normalize_code(code))
    if row is None:
        raise InviteInvalid
    _bounded_lock_wait()
    lot = lock_lot(row["parking_lot_id"])  # lot first, then the account
    account = User.objects.select_for_update(no_key=True).get(pk=user.pk)
    if (
        lot.status != LotStatus.ACTIVE
        or not account.is_active
        or account.role in (User.Role.OWNER, User.Role.ADMIN)
    ):
        raise InviteInvalid  # checked BEFORE the code is spent: an owner's try burns nothing
    spent = OperatorInvite.objects.filter(
        pk=row["pk"], used_at__isnull=True, revoked_at__isnull=True, expires_at__gt=now
    ).update(used_at=now, used_by=account)
    if not spent:
        raise InviteInvalid
    promoted = account.role != User.Role.OPERATOR
    if promoted:
        account.role = User.Role.OPERATOR
        account.save(update_fields=["role"])
    if not selectors.active_assignments(lot).filter(operator=account).exists():
        OperatorAssignment.objects.create(
            operator=account, parking_lot=lot, created_by_id=row["created_by_id"]
        )
    audit(
        actor=account,
        action="operator.invite_accept",
        obj_id=row["pk"],
        before={},
        after={"lot": str(lot.pk), "role_promoted": promoted},
    )
    return lot


# --- ending an assignment ------------------------------------------------------------------------


@booking_services.retrying
@transaction.atomic
def revoke_operator(*, lot: ParkingLot, assignment_id, actor) -> None:
    """End an assignment (idempotent). The last one also demotes the account to DRIVER."""
    try:
        assignment_uuid = uuid.UUID(str(assignment_id))
    except ValueError as exc:  # the URL pattern only checks the shape, not that it is a UUID
        raise NotFoundError("Assignment not found.") from exc
    _bounded_lock_wait()
    lock_lot(lot.pk)
    assignment = OperatorAssignment.objects.filter(pk=assignment_uuid, parking_lot=lot).first()
    if assignment is None:
        raise NotFoundError("Assignment not found.")
    if assignment.revoked_at is not None:
        return
    user = User.objects.select_for_update(no_key=True).get(pk=assignment.operator_id)
    assignment.revoked_at = timezone.now()
    assignment.revoked_by = actor
    assignment.save(update_fields=["revoked_at", "revoked_by"])
    demoted = False
    still_assigned = OperatorAssignment.objects.filter(
        operator=user, revoked_at__isnull=True
    ).exists()
    if user.role == User.Role.OPERATOR and not still_assigned:
        user.role = User.Role.DRIVER
        user.save(update_fields=["role"])
        demoted = True
    audit(
        actor=actor,
        action="operator.revoke",
        obj_id=assignment.pk,
        before={"operator": str(user.pk), "lot": str(lot.pk)},
        after={"role_demoted": demoted},
    )
