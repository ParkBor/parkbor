"""Shared test helpers (users, lots, authenticated clients)."""

from itertools import count

from django.contrib.auth import get_user_model
from rest_framework.test import APIClient

from apps.core.geo import make_point
from apps.parking.models import ParkingLot

_telegram_ids = count(5_000_000)


def make_user(role, **extra):
    return get_user_model().objects.create_user(telegram_id=next(_telegram_ids), role=role, **extra)


def make_lot(owner, name="Lot", **extra):
    return ParkingLot.objects.create(
        owner=owner, name=name, address="Tashkent", location=make_point(69.24, 41.31), **extra
    )


def client_for(user):
    client = APIClient()
    client.force_authenticate(user)
    return client
