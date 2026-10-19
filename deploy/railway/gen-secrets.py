#!/usr/bin/env python3
"""Prints freshly generated secrets for Railway (docs/RAILWAY.md, step 4). Nothing is written to
disk and nothing is sent anywhere: copy the output into Railway's variable editor, then clear your
terminal. Run:  python deploy/railway/gen-secrets.py [--staging]

Alphanumeric only (no '$', no URL-special characters): safe inside DATABASE_URL / REDIS_URL and
Railway's ${{ }} reference syntax.

--staging also prints RANDOM PLACEHOLDERS for the Payme / Click credentials. They satisfy the
production start-up checks (config/settings/prod.py + apps/payments/settings_checks.py) so the
stack boots before the merchant contracts exist, but real payments cannot work with them.
"""

import secrets
import string
import sys

ALPHABET = string.ascii_letters + string.digits


def token(length: int) -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


def main() -> None:
    lines = {
        "SECRET_KEY": token(64),
        "JWT_SIGNING_KEY": token(64),
        "QR_SIGNING_KEY": token(64),  # >= 50 characters is enforced at start-up
        "TELEGRAM_WEBHOOK_SECRET": token(40),  # Telegram: 1-256 chars, A-Z a-z 0-9 _ -
        "POSTGRES_PASSWORD": token(32),
        "REDIS_PASSWORD": token(32),
        "CACHE_REDIS_PASSWORD": token(32),
        "HABI_SUPERADMIN_PASSWORD": token(24),  # only for the one-off create_superadmin
    }
    if "--staging" in sys.argv[1:]:
        lines |= {
            "PAYME_MERCHANT_ID": token(24),
            "PAYME_KEY": token(40),  # >= 32 characters is enforced
            "CLICK_SERVICE_ID": "1" + token(5),
            "CLICK_MERCHANT_ID": "1" + token(5),
            "CLICK_MERCHANT_USER_ID": "1" + token(5),
            "CLICK_SECRET_KEY": token(24),  # >= 12 characters is enforced
        }
    for name, value in lines.items():
        print(f"{name}={value}")


if __name__ == "__main__":
    main()
