"""Operator command: settle a MANUAL or FAILED refund.

    manage.py resolve_refund <refund id> --actor <who> --done   --note "refunded in Payme cabinet"
    manage.py resolve_refund <refund id> --actor <who> --retry  --note "Click cabinet: not reversed"
    manage.py resolve_refund <refund id> --actor <who> --failed --note "customer declined"

``--actor`` (required) is the operator: a user id (UUID), a Telegram id (digits) or ``@username``.
The user must exist, be active and be an ADMIN; the action is recorded under that identity in the
booking history and the audit log. Notes are free text: do NOT put phone / card numbers in them
(the command refuses values that look like one).

Rules: ``--done`` MANUAL | FAILED; ``--retry`` FAILED only (not for refunds an operator already
gave up on); ``--failed`` MANUAL only and FINAL (returns the reserved amount to the payment).
"""

import uuid

from django.core.management.base import BaseCommand, CommandError

from apps.accounts.models import User
from apps.core.exceptions import ApiError
from apps.payments import refunds


def find_operator(identifier: str) -> User:
    """Resolve ``--actor``; only active ADMIN users may settle money."""
    identifier = identifier.strip()
    users = User.objects.all()
    try:
        if identifier.startswith("@"):
            user = users.get(telegram_username__iexact=identifier[1:])
        elif identifier.isdigit():
            user = users.get(telegram_id=int(identifier))
        else:
            user = users.get(pk=uuid.UUID(identifier))
    except (User.DoesNotExist, User.MultipleObjectsReturned, ValueError) as exc:
        raise CommandError("--actor does not name exactly one user.") from exc
    if not user.is_active or user.role != User.Role.ADMIN:
        raise CommandError("--actor must be an active ADMIN user.")
    return user


class Command(BaseCommand):
    help = "Resolve a MANUAL / FAILED refund (--done, --retry or --failed) as a named operator."

    def add_arguments(self, parser):
        parser.add_argument("refund_id", help="Refund id (UUID).")
        parser.add_argument(
            "--actor", required=True, help="Operator: user id, Telegram id or @name."
        )
        group = parser.add_mutually_exclusive_group(required=True)
        group.add_argument("--done", action="store_const", const="done", dest="outcome")
        group.add_argument("--retry", action="store_const", const="retry", dest="outcome")
        group.add_argument("--failed", action="store_const", const="failed", dest="outcome")
        parser.add_argument("--note", default="", help="Short reason, no phone/card numbers.")

    def handle(self, *args, **options):
        try:
            refund_id = uuid.UUID(options["refund_id"])
        except ValueError as exc:
            raise CommandError("refund_id must be a UUID.") from exc
        operator = find_operator(options["actor"])
        try:
            refund = refunds.resolve_manual_refund(
                refund_id, options["outcome"], actor=operator, note=options["note"]
            )
        except ApiError as exc:
            raise CommandError(str(exc.detail["detail"])) from exc
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        self.stdout.write(f"Refund {refund.pk} is now {refund.status}.")
