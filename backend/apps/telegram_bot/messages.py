"""Bot texts (uz, ru, en). Plain text only; no user data is interpolated except the login code."""

DEFAULT_LANGUAGE = "uz"
SUPPORTED_LANGUAGES = ("uz", "ru", "en")

MESSAGES: dict[str, dict[str, str]] = {
    "uz": {
        "help": (
            "Salom! Habi avtoturargoh botiga xush kelibsiz.\n"
            "Kirish uchun Habi ilovasidagi «Telegram orqali kirish» tugmasini bosing."
        ),
        "ask_contact": (
            "Habi ilovasida kirish so'rovi qabul qilindi. "
            "Faqat Habi ilovasida o'zingiz boshlagan bo'lsangiz davom eting. "
            "Telefon raqamingizni yuboring: pastdagi tugmani bosing."
        ),
        "share_button": "Raqamni yuborish",
        "login_invalid": (
            "Kirish so'rovi topilmadi yoki muddati tugagan. "
            "Ilovada «Telegram orqali kirish» tugmasini qayta bosing."
        ),
        "foreign_contact": "Faqat o'zingizning raqamingizni yuborishingiz mumkin.",
        "invalid_phone": "Telefon raqami noto'g'ri. Tugma orqali o'z raqamingizni yuboring.",
        "code_sent": (
            "Kirish kodingiz: {code} (5 daqiqa amal qiladi). Uni faqat Habi ilovasiga kiriting. "
            "Kodni hech kimga bermang!"
        ),
    },
    "ru": {
        "help": (
            "Здравствуйте! Это бот парковок Habi.\n"
            "Для входа нажмите кнопку «Войти через Telegram» в приложении Habi."
        ),
        "ask_contact": (
            "Запрос на вход в приложении Habi получен. "
            "Продолжайте, только если вы сами начали вход в приложении Habi. "
            "Отправьте свой номер телефона: нажмите кнопку ниже."
        ),
        "share_button": "Отправить номер",
        "login_invalid": (
            "Запрос на вход не найден или истёк. "
            "Нажмите «Войти через Telegram» в приложении ещё раз."
        ),
        "foreign_contact": "Можно отправить только свой собственный номер.",
        "invalid_phone": "Некорректный номер телефона. Отправьте свой номер кнопкой.",
        "code_sent": (
            "Ваш код для входа: {code} (действует 5 минут). Вводите его только в приложении Habi. "
            "Никому не сообщайте код!"
        ),
    },
    "en": {
        "help": (
            "Hello! This is the Habi parking bot.\n"
            'To sign in, tap the "Sign in with Telegram" button in the Habi app.'
        ),
        "ask_contact": (
            "We received your sign-in request from the Habi app. "
            "Continue only if you started this sign-in yourself in the Habi app. "
            "Please share your phone number using the button below."
        ),
        "share_button": "Share phone number",
        "login_invalid": (
            'Login request not found or expired. Tap "Sign in with Telegram" in the app again.'
        ),
        "foreign_contact": "You can only share your own phone number.",
        "invalid_phone": "Invalid phone number. Share your own number with the button.",
        "code_sent": (
            "Your login code: {code} (valid for 5 minutes). Enter it only in the Habi app. "
            "Do not share it with anyone!"
        ),
    },
}


def pick_language(*candidates: str | None) -> str:
    """First candidate that is a supported language (accepts "ru-RU" style codes)."""
    for candidate in candidates:
        short = (candidate or "")[:2].lower()
        if short in SUPPORTED_LANGUAGES:
            return short
    return DEFAULT_LANGUAGE


def text(language: str, key: str, **params: str) -> str:
    template = MESSAGES.get(language, MESSAGES[DEFAULT_LANGUAGE])[key]
    return template.format(**params) if params else template
