from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.telegram_bot import client as bot_client

WEBHOOK_PATH = "/api/v1/telegram/webhook"


class Command(BaseCommand):
    help = "Register (or with --delete, remove) the Telegram webhook with the secret from env."

    def add_arguments(self, parser):
        parser.add_argument("--base-url", help="Public HTTPS origin, e.g. https://api.parkbor.uz")
        parser.add_argument("--delete", action="store_true", help="Remove the webhook instead.")

    def handle(self, *args, **options):
        try:
            client = bot_client.get_client()
            if options["delete"]:
                client.delete_webhook()
                self.stdout.write(self.style.SUCCESS("Webhook deleted."))
                return
            base_url = (options["base_url"] or "").rstrip("/")
            if not base_url.startswith("https://"):
                raise CommandError("--base-url must be an https:// URL (Telegram requires HTTPS).")
            if not settings.TELEGRAM_WEBHOOK_SECRET:
                raise CommandError("TELEGRAM_WEBHOOK_SECRET is not set.")
            client.set_webhook(base_url + WEBHOOK_PATH, settings.TELEGRAM_WEBHOOK_SECRET)
        except bot_client.TelegramAPIError as exc:
            raise CommandError(str(exc)) from None
        self.stdout.write(self.style.SUCCESS(f"Webhook set to {base_url}{WEBHOOK_PATH}"))
