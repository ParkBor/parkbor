from django.urls import path

from . import views

urlpatterns = [path("ws/ticket", views.WsTicketView.as_view(), name="ws-ticket")]
