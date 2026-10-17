from apps.accounts import selectors as account_selectors
from apps.accounts.models import User


def get_widget_user(telegram_id: int) -> User | None:
    """Account that may sign in with the Login Widget (existing users only)."""
    return account_selectors.get_user_by_telegram_id(telegram_id)
