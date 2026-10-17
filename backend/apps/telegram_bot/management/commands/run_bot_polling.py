import logging
import time

from django.core.management.base import BaseCommand, CommandError

from apps.telegram_bot import client as bot_client
from apps.telegram_bot import handlers

logger = logging.getLogger(__name__)

ERROR_BACKOFF_SECONDS = 3


class Command(BaseCommand):
    help = "Long-poll Telegram for updates (local development; removes any webhook first)."

    def add_arguments(self, parser):
        parser.add_argument("--timeout", type=int, default=30, help="Long-poll seconds.")
        parser.add_argument(
            "--max-iterations", type=int, default=0, help="Stop after N polls (0 = forever)."
        )

    def handle(self, *args, **options):
        try:
            client = bot_client.get_client()
            client.delete_webhook()  # getUpdates and webhooks are mutually exclusive
        except bot_client.TelegramAPIError as exc:
            raise CommandError(str(exc)) from None
        self.stdout.write("Polling for updates. Press Ctrl+C to stop.")
        offset = None
        iterations = 0
        try:
            while not options["max_iterations"] or iterations < options["max_iterations"]:
                iterations += 1
                offset = self._poll_once(client, offset, options["timeout"])
        except KeyboardInterrupt:
            self.stdout.write("Stopped.")

    def _poll_once(self, client, offset, timeout):
        try:
            updates = client.get_updates(offset=offset, timeout=timeout)
        except bot_client.TelegramAPIError:
            logger.exception("getUpdates failed")
            time.sleep(ERROR_BACKOFF_SECONDS)
            return offset
        for update in updates:
            try:
                handlers.handle_update(update, client)
            except Exception:
                logger.exception("update %s failed", update.get("update_id"))
            update_id = update.get("update_id")
            if isinstance(update_id, int):
                offset = update_id + 1
        return offset
