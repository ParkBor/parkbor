import getpass
import os

from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError

from apps.accounts.models import User
from apps.core.phone import normalize_phone

PASSWORD_ENV = "HABI_SUPERADMIN_PASSWORD"  # noqa: S105 - env var name, not a secret


class Command(BaseCommand):
    help = (
        "Create the back-up super admin (the only account with a password). "
        f"The password is read from ${PASSWORD_ENV} or an interactive prompt, never from arguments."
    )

    def add_arguments(self, parser):
        parser.add_argument("--telegram-id", type=int, required=True)
        parser.add_argument("--first-name", default="")
        parser.add_argument("--phone", default=None)

    def handle(self, *args, **options):
        telegram_id = options["telegram_id"]
        if User.objects.filter(telegram_id=telegram_id).exists():
            raise CommandError(f"A user with telegram_id={telegram_id} already exists.")
        phone = None
        if options["phone"]:
            phone = normalize_phone(options["phone"])
            if phone is None:
                raise CommandError("Invalid --phone.")
        password = self._read_password()
        User.objects.create_superuser(
            telegram_id=telegram_id,
            password=password,
            first_name=options["first_name"],
            phone=phone,
        )
        self.stdout.write(self.style.SUCCESS(f"Super admin {telegram_id} created."))

    def _read_password(self) -> str:
        password = os.environ.get(PASSWORD_ENV)
        if not password:
            password = getpass.getpass("Password: ")
            if getpass.getpass("Password (again): ") != password:
                raise CommandError("Passwords do not match.")
        try:
            validate_password(password)  # AUTH_PASSWORD_VALIDATORS: length 12+, not common/numeric
        except ValidationError as exc:
            raise CommandError("; ".join(exc.messages)) from None
        return password
