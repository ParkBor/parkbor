"""Provider webhooks (ARCHITECTURE 9.1). Thin: edge checks -> adapter -> audit row -> answer.

Protected by the provider's own authentication (Payme Basic auth, Click md5 signature) checked in
the adapter, plus an optional IP allowlist and a per-IP throttle. No JWT, no CSRF (the API has no
cookies/sessions). Every outcome the provider can cause is a protocol answer with HTTP 200;
only a caller that is not the provider (wrong address, oversized body, flood) gets an HTTP error.
"""

import time

from django.utils import timezone
from drf_spectacular.utils import extend_schema
from rest_framework.negotiation import DefaultContentNegotiation
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.core.serializers import error_responses as errors

from . import events, security
from .providers.base import WebhookRequest
from .providers.payme import PaymeProvider
from .providers.registry import get_provider
from .serializers import (
    ClickWebhookRequestSerializer,
    ClickWebhookResponseSerializer,
    PaymeRpcRequestSerializer,
    PaymeRpcResponseSerializer,
)


class AnyAcceptNegotiation(DefaultContentNegotiation):
    """Providers send odd Accept headers; they always get JSON (never a 406)."""

    def select_renderer(self, request, renderers, format_suffix=None):
        return renderers[0], renderers[0].media_type


class _WebhookView(APIView):
    authentication_classes: list = []  # the provider authenticates itself, inside the adapter
    permission_classes = [security.ProviderIpAllowed]
    throttle_classes = [security.WebhookIpThrottle]
    parser_classes: list = []  # the adapter reads the raw body
    renderer_classes = [JSONRenderer]
    content_negotiation_class = AnyAcceptNegotiation
    provider_code = ""

    def _process(self, request) -> Response:
        started = time.monotonic()
        body = security.read_body(request)
        remote_ip = security.client_ip(request)
        webhook = WebhookRequest(
            body=body,
            headers={
                "authorization": request.headers.get("Authorization", ""),
                "content-type": request.headers.get("Content-Type", ""),
            },
            remote_ip=remote_ip,
        )
        result = get_provider(self.provider_code).handle_webhook(webhook, now=timezone.now())
        events.record(
            self.provider_code,
            result,
            remote_ip=remote_ip,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        return self._answer(result)

    @staticmethod
    def _answer(result) -> Response:
        response = Response(result.payload, status=result.http_status)
        response["Cache-Control"] = "no-store"
        return response


class PaymeWebhookView(_WebhookView):
    provider_code = "payme"

    @extend_schema(
        operation_id="payments_payme_webhook",
        summary="Payme Merchant API (JSON-RPC 2.0), called by Payme only",
        description="Basic auth `Paycom:<key>`, amounts in tiyin, HTTP 200 for every protocol "
        "outcome. Methods: CheckPerformTransaction, CreateTransaction, PerformTransaction, "
        "CancelTransaction, CheckTransaction, GetStatement. A non-POST request is answered with "
        "error -32300.",
        request=PaymeRpcRequestSerializer,
        responses={200: PaymeRpcResponseSerializer, **errors(403, 413, 429)},
        auth=[],
    )
    def post(self, request):
        return self._process(request)

    def http_method_not_allowed(self, request, *args, **kwargs):
        return self._answer(PaymeProvider().method_not_allowed())


class ClickWebhookView(_WebhookView):
    provider_code = "click"

    @extend_schema(
        operation_id="payments_click_webhook",
        summary="Click SHOP API (Prepare action=0 / Complete action=1), called by Click only",
        description="`application/x-www-form-urlencoded`, md5 `sign_string`; the answer is JSON "
        "with HTTP 200 and `error` 0 or -1..-9.",
        request={"application/x-www-form-urlencoded": ClickWebhookRequestSerializer},
        responses={200: ClickWebhookResponseSerializer, **errors(403, 413, 429)},
        auth=[],
    )
    def post(self, request):
        return self._process(request)
