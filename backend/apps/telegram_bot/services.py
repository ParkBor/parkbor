"""Telegram authentication use-cases (compose login_service/widget with account services)."""

from django.conf import settings

from apps.accounts import services as account_services
from apps.accounts.models import User
from apps.core.exceptions import InvalidWidgetError, RoleNotAllowedError
from apps.telegram_bot import login_service, selectors
from apps.telegram_bot.widget import consume_widget_hash, verify_telegram_widget

WIDGET_ROLES = (User.Role.OWNER, User.Role.ADMIN)


def bot_url(token: str) -> str:
    return f"https://t.me/{settings.TELEGRAM_BOT_USERNAME}?start={token}"


def verify_bot_login(token: str, code: str) -> account_services.LoginResult:
    identity = login_service.verify_code(token, code)
    return account_services.login_with_telegram(
        telegram_id=identity.telegram_id,
        phone=identity.phone,
        username=identity.username,
        first_name=identity.first_name,
        last_name=identity.last_name,
    )


def widget_login(widget_data: dict) -> account_services.LoginResult:
    """Admin-panel sign-in: valid HMAC, and an existing active OWNER/ADMIN account."""
    if not verify_telegram_widget(widget_data, settings.TELEGRAM_BOT_TOKEN):
        raise InvalidWidgetError
    if not consume_widget_hash(widget_data["hash"]):  # replay of an already used payload
        raise InvalidWidgetError
    user = selectors.get_widget_user(int(widget_data["id"]))
    if user is None or user.role not in WIDGET_ROLES:
        raise RoleNotAllowedError
    account_services.require_active(user)
    return account_services.LoginResult(user=user, is_new=False)
