"""Notification texts (uz, ru, en). Plain text only.

No personal data: never a plate, phone or name. The only values interpolated are the slot code
(a label painted on the asphalt) and, in refund messages, the amount. The context is inserted
literally (never interpreted as a format string).
"""

import string
from dataclasses import dataclass
from decimal import Decimal

from django.conf import settings

from . import events as ev

DEFAULT_LANGUAGE = "uz"
SUPPORTED_LANGUAGES = ("uz", "ru", "en")

TEMPLATES: dict[str, dict[str, dict[str, str]]] = {
    ev.BOOKING_CONFIRMED: {
        "uz": {
            "title": "Bron tasdiqlandi",
            "body": "To'lov qabul qilindi. Bron va QR kodni ilovada ko'ring.",
        },
        "ru": {
            "title": "Бронь подтверждена",
            "body": "Оплата получена. Бронь и QR-код доступны в приложении.",
        },
        "en": {
            "title": "Booking confirmed",
            "body": "Payment received. Your booking and QR code are in the app.",
        },
    },
    ev.BOOKING_EXPIRED: {
        "uz": {
            "title": "Bron muddati tugadi",
            "body": "To'lov o'z vaqtida qilinmadi, joy bo'shatildi. "
            "Kerak bo'lsa qayta bron qiling.",
        },
        "ru": {
            "title": "Время брони истекло",
            "body": "Оплата не поступила вовремя, место освобождено. "
            "При необходимости забронируйте снова.",
        },
        "en": {
            "title": "Booking expired",
            "body": "Payment was not made in time and the spot was released. Book again if needed.",
        },
    },
    ev.BOOKING_CANCELLED: {
        "uz": {"title": "Bron bekor qilindi", "body": "Bron bekor qilindi."},
        "ru": {"title": "Бронь отменена", "body": "Бронь отменена."},
        "en": {"title": "Booking cancelled", "body": "Your booking was cancelled."},
    },
    ev.NO_SHOW: {
        "uz": {
            "title": "Bron bekor qilindi",
            "body": "Siz kelmadingiz, shuning uchun bron bekor qilindi.",
        },
        "ru": {
            "title": "Бронь отменена",
            "body": "Вы не приехали, поэтому бронь была отменена.",
        },
        "en": {
            "title": "Booking cancelled",
            "body": "You did not arrive, so the booking was cancelled.",
        },
    },
    ev.REMINDER_15M_LEFT: {
        "uz": {
            "title": "Bron tugashiga oz qoldi",
            "body": "Bron tugashiga {minutes} daqiqa qoldi. Joyni bo'shatishga tayyorlaning.",
        },
        "ru": {
            "title": "Скоро конец брони",
            "body": "До конца брони осталось {minutes} мин. Подготовьтесь освободить место.",
        },
        "en": {
            "title": "Your booking ends soon",
            "body": "Your booking ends in {minutes} min. Get ready to leave the spot.",
        },
    },
    ev.OVERSTAY_DETECTED: {
        "uz": {
            "title": "Bron muddati tugadi",
            "body": "Bron muddati tugadi, lekin siz hali chiqmadingiz. Joyni bo'shating: "
            "qo'shimcha vaqt uchun to'lov hisoblanadi.",
        },
        "ru": {
            "title": "Время брони истекло",
            "body": "Время брони истекло, а вы ещё не выехали. Освободите место: "
            "дополнительное время оплачивается.",
        },
        "en": {
            "title": "Booking time is over",
            "body": "Your booking has ended but you have not left yet. Please free the spot: "
            "extra time is charged.",
        },
    },
    ev.SLOT_REASSIGNED: {
        "uz": {
            "title": "Sizga boshqa joy ajratildi",
            "body": "Yangi joy: {slot}. QR kodingiz o'zgarmadi.",
        },
        "ru": {
            "title": "Вам назначено другое место",
            "body": "Новое место: {slot}. Ваш QR-код остался прежним.",
        },
        "en": {
            "title": "You have been given another spot",
            "body": "New spot: {slot}. Your QR code is unchanged.",
        },
    },
    ev.OVERSTAY_CONFLICT: {
        "uz": {
            "title": "Joyingiz hali band",
            "body": "Joyingizni oldingi mashina bo'shatmadi va boshqa bo'sh joy yo'q. "
            "Iltimos, kirishdagi operatorga murojaat qiling.",
        },
        "ru": {
            "title": "Ваше место ещё занято",
            "body": "Предыдущий автомобиль не освободил ваше место, а свободных мест нет. "
            "Обратитесь к оператору на входе.",
        },
        "en": {
            "title": "Your spot is still occupied",
            "body": "The previous car has not left your spot and no other spot is free. "
            "Please contact the operator at the gate.",
        },
    },
    ev.REFUND_DONE: {
        "uz": {
            "title": "Pul qaytarildi",
            "body": "{amount} so'm to'lov usulingizga qaytarildi.",
        },
        "ru": {
            "title": "Деньги возвращены",
            "body": "{amount} сум возвращены на ваш способ оплаты.",
        },
        "en": {
            "title": "Refund completed",
            "body": "{amount} UZS was returned to your payment method.",
        },
    },
    ev.REFUND_MANUAL: {
        "uz": {
            "title": "Pulni qaytarish",
            "body": "{amount} so'm qo'lda qaytariladi, bu 1–3 ish kuni davom etadi.",
        },
        "ru": {
            "title": "Возврат средств",
            "body": "{amount} сум будут возвращены вручную в течение 1–3 рабочих дней.",
        },
        "en": {
            "title": "Refund in progress",
            "body": "{amount} UZS will be refunded manually within 1–3 working days.",
        },
    },
    ev.REFUND_FAILED: {
        "uz": {
            "title": "Pulni qaytarishda muammo",
            "body": "{amount} so'mni avtomatik qaytarib bo'lmadi. "
            "Yordam xizmatiga murojaat qiling.",
        },
        "ru": {
            "title": "Проблема с возвратом",
            "body": "Не удалось автоматически вернуть {amount} сум. Обратитесь в поддержку.",
        },
        "en": {
            "title": "Refund problem",
            "body": "We could not refund {amount} UZS automatically. Please contact support.",
        },
    },
}

OPEN_BUTTON = {"uz": "Bronni ochish", "ru": "Открыть бронь", "en": "Open booking"}


@dataclass(frozen=True)
class Message:
    title: str
    body: str


class _Context(dict):
    """Missing values render as empty text instead of raising."""

    def __missing__(self, key):
        return ""


def format_amount(amount) -> str:
    value = Decimal(str(amount))
    if value == value.to_integral_value():
        return f"{int(value):,}".replace(",", " ")
    return f"{value:.2f}"


def pick_language(language: str | None) -> str:
    short = (language or "")[:2].lower()
    return short if short in SUPPORTED_LANGUAGES else DEFAULT_LANGUAGE


def render(event: str, language: str | None, context: dict) -> Message:
    entry = TEMPLATES[event][pick_language(language)]
    values = _Context(
        minutes=settings.NOTIFICATION_REMINDER_MINUTES,
        slot=str(context.get("slot", ""))[:20],
        amount=format_amount(context["amount"]) if context.get("amount") is not None else "",
    )
    formatter = string.Formatter()
    return Message(
        title=formatter.vformat(entry["title"], (), values),
        body=formatter.vformat(entry["body"], (), values),
    )
