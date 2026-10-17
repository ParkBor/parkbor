from django.urls import path

from . import views

urlpatterns = [
    path("payments/payme/webhook", views.PaymeWebhookView.as_view(), name="payments-payme-webhook"),
    path("payments/click/webhook", views.ClickWebhookView.as_view(), name="payments-click-webhook"),
]
