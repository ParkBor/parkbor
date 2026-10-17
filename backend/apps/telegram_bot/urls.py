from django.urls import path

from apps.telegram_bot import views

urlpatterns = [
    path("auth/telegram/start", views.StartLoginView.as_view(), name="telegram-login-start"),
    path("auth/telegram/status", views.LoginStatusView.as_view(), name="telegram-login-status"),
    path("auth/telegram/verify", views.VerifyLoginView.as_view(), name="telegram-login-verify"),
    path("auth/telegram/widget", views.WidgetLoginView.as_view(), name="telegram-login-widget"),
    path("telegram/webhook", views.WebhookView.as_view(), name="telegram-webhook"),
]
