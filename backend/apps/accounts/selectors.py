from apps.accounts.models import User


def get_user_by_telegram_id(telegram_id: int) -> User | None:
    return User.objects.filter(telegram_id=telegram_id).first()


def get_language_for_telegram_id(telegram_id: int) -> str | None:
    return User.objects.filter(telegram_id=telegram_id).values_list("language", flat=True).first()


def phone_belongs_to_other_user(phone: str, telegram_id: int) -> bool:
    return User.objects.filter(phone=phone).exclude(telegram_id=telegram_id).exists()
