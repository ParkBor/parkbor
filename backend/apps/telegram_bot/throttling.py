import time

from rest_framework.throttling import SimpleRateThrottle


class TelegramAuthThrottle(SimpleRateThrottle):
    """10 requests/minute per client IP, counted separately for each auth endpoint."""

    scope = "telegram_auth"
    # Resolve time.time at call time (a plain builtin attribute gets rewritten by time freezing).
    timer = staticmethod(lambda: time.time())

    def get_cache_key(self, request, view):
        return self.cache_format % {
            "scope": f"{self.scope}:{type(view).__name__}",
            "ident": self.get_ident(request),
        }


class TelegramStatusThrottle(TelegramAuthThrottle):
    """Status is polled by the app while the user is in the bot, so it gets a higher limit."""

    scope = "telegram_auth_status"


class TokenRefreshThrottle(TelegramAuthThrottle):
    scope = "token_refresh"
