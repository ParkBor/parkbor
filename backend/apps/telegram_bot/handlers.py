"""Bot update handlers (shared by the webhook and the polling command)."""

import logging
from typing import Protocol

from apps.accounts import selectors
from apps.core.logging_utils import mask_phone
from apps.core.phone import normalize_phone
from apps.telegram_bot import login_service, messages

logger = logging.getLogger(__name__)


class BotClient(Protocol):
    def send_message(self, chat_id: int, text: str, reply_markup: dict | None = None): ...


_MAX_NAME_LENGTH = 150
_MAX_USERNAME_LENGTH = 64
_REMOVE_KEYBOARD = {"remove_keyboard": True}


def handle_update(update: dict, client: BotClient) -> None:
    """Process one Telegram update. Unsupported updates are ignored silently."""
    message = update.get("message")
    if not isinstance(message, dict):
        return
    sender = message.get("from")
    chat = message.get("chat")
    if not isinstance(sender, dict) or not isinstance(chat, dict):
        return
    sender_id = sender.get("id")
    if chat.get("type") != "private" or type(sender_id) is not int:
        return
    language = messages.pick_language(
        selectors.get_language_for_telegram_id(sender_id), sender.get("language_code")
    )
    contact = message.get("contact")
    if isinstance(contact, dict):
        _handle_contact(client, chat["id"], sender, contact, language)
        return
    text = message.get("text")
    if isinstance(text, str) and text.split(maxsplit=1)[:1] == ["/start"]:
        _handle_start(client, chat["id"], sender_id, text, language)
        return
    client.send_message(chat["id"], messages.text(language, "help"))


def _contact_keyboard(language: str) -> dict:
    button = {"text": messages.text(language, "share_button"), "request_contact": True}
    return {"keyboard": [[button]], "resize_keyboard": True, "one_time_keyboard": True}


def _handle_start(
    client: BotClient, chat_id: int, sender_id: int, text: str, language: str
) -> None:
    parts = text.split(maxsplit=1)
    token = parts[1].strip() if len(parts) > 1 else ""
    if not token:
        client.send_message(chat_id, messages.text(language, "help"))
        return
    if not login_service.bind_chat(token, sender_id):
        client.send_message(chat_id, messages.text(language, "login_invalid"))
        return
    client.send_message(
        chat_id, messages.text(language, "ask_contact"), _contact_keyboard(language)
    )


def _handle_contact(
    client: BotClient, chat_id: int, sender: dict, contact: dict, language: str
) -> None:
    sender_id = sender["id"]
    token = login_service.token_for_chat(sender_id)
    if token is None:
        client.send_message(chat_id, messages.text(language, "login_invalid"))
        return
    # Only the owner's own contact is accepted (user_id is set by Telegram, not by the client).
    if type(contact.get("user_id")) is not int or contact["user_id"] != sender_id:
        logger.warning("foreign contact rejected telegram_id=%s", sender_id)
        client.send_message(
            chat_id, messages.text(language, "foreign_contact"), _contact_keyboard(language)
        )
        return
    phone = normalize_phone(str(contact.get("phone_number", "")))
    if phone is None:
        client.send_message(
            chat_id, messages.text(language, "invalid_phone"), _contact_keyboard(language)
        )
        return
    identity = login_service.TelegramIdentity(
        telegram_id=sender_id,
        phone=phone,
        username=str(sender.get("username") or "")[:_MAX_USERNAME_LENGTH],
        first_name=str(contact.get("first_name") or sender.get("first_name") or "")[
            :_MAX_NAME_LENGTH
        ],
        last_name=str(contact.get("last_name") or sender.get("last_name") or "")[:_MAX_NAME_LENGTH],
    )
    code = login_service.confirm_contact(token, identity)
    if code is None:
        client.send_message(chat_id, messages.text(language, "login_invalid"), _REMOVE_KEYBOARD)
        return
    logger.info("code issued telegram_id=%s phone=%s", sender_id, mask_phone(phone))
    try:
        client.send_message(
            chat_id, messages.text(language, "code_sent", code=code), _REMOVE_KEYBOARD
        )
    except Exception:
        # The code never reached the user: drop the session so it cannot linger unseen, and
        # tell them to start over. (The code itself is never logged.)
        logger.exception("could not deliver login code telegram_id=%s", sender_id)
        login_service.cancel_login(token)
        _notify_best_effort(client, chat_id, messages.text(language, "login_invalid"))


def _notify_best_effort(client: BotClient, chat_id: int, text: str) -> None:
    try:
        client.send_message(chat_id, text, _REMOVE_KEYBOARD)
    except Exception:
        logger.warning("could not notify chat %s after a delivery failure", chat_id)
