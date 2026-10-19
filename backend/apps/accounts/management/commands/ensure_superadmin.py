import os

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.accounts.models import User

IDS_ENV = "SUPERADMIN_TELEGRAM_IDS"


def ids_from_env() -> list[int]:
    """Comma/space separated Telegram ids from $SUPERADMIN_TELEGRAM_IDS (empty -> none)."""
    raw = os.environ.get(IDS_ENV, "")
    try:
        return [int(part) for part in raw.replace(",", " ").split()]
    except ValueError:
        raise CommandError(f"${IDS_ENV} must be a comma separated list of integers.") from None


class Command(BaseCommand):
    help = (
        "Make Telegram accounts super admins (create them, or promote existing ones). Ids come "
        f"from --telegram-id (repeatable) or, without it, from ${IDS_ENV}. Idempotent and safe to "
        "run on every deploy: it never fails because an account exists, keeps any existing "
        "password and profile, and creates new accounts Telegram-only (no usable password). "
        "Nothing configured means nothing to do. For the password-backed back-up admin use "
        "create_superadmin."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--telegram-id",
            type=int,
            action="append",
            dest="telegram_ids",
            help="Repeat the option for several accounts.",
        )

    def handle(self, *args, **options):
        telegram_ids = options["telegram_ids"] or ids_from_env()
        if not telegram_ids:
            self.stdout.write(
                f"No super admin ids configured (${IDS_ENV} is empty): nothing to do."
            )
            return
        if any(telegram_id <= 0 for telegram_id in telegram_ids):
            raise CommandError("Telegram ids must be positive integers.")
        with transaction.atomic():
            for telegram_id in dict.fromkeys(telegram_ids):
                self._ensure(telegram_id)

    def _ensure(self, telegram_id: int) -> None:
        user = User.objects.select_for_update().filter(telegram_id=telegram_id).first()
        if user is None:
            User.objects.create_user(telegram_id, None, role=User.Role.ADMIN, is_superuser=True)
            self.stdout.write(self.style.SUCCESS(f"Super admin {telegram_id} created."))
            return
        user.role = User.Role.ADMIN
        user.is_superuser = True
        user.is_active = True
        user.save(update_fields=["role", "is_superuser", "is_active"])
        self.stdout.write(self.style.SUCCESS(f"Super admin {telegram_id} ensured (existing)."))
