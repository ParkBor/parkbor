from django.urls import path

from . import views

urlpatterns = [
    path(
        "operator-invites/accept", views.AcceptInviteView.as_view(), name="operator-invite-accept"
    ),
]
