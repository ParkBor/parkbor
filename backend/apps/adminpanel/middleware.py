"""Every response under /api/v1/admin/ (errors too) is private: names, plates and money must not
sit in a shared or browser cache."""

ADMIN_PREFIX = "/api/v1/admin/"


class AdminNoStoreMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)
        if request.path.startswith(ADMIN_PREFIX):
            response["Cache-Control"] = "no-store"
        return response
