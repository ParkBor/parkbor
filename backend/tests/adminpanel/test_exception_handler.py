"""Generic DB/ORM errors become clean {detail, code} responses without leaking internals."""

from unittest import mock

import pytest
from django.core.exceptions import ObjectDoesNotExist
from django.db import IntegrityError
from django.db.models import ProtectedError

from apps.core.exception_handler import api_exception_handler
from apps.parking import services
from apps.parking.models import Slot
from tests.helpers import client_for

pytestmark = pytest.mark.django_db

SECRET = 'duplicate key value violates unique constraint "slot_secret_idx" DETAIL: Key (x)=(1)'


def handle(exc):
    return api_exception_handler(exc, {"view": None, "request": None})


def test_integrity_error_is_409_without_database_text():
    response = handle(IntegrityError(SECRET))
    assert response.status_code == 409
    assert set(response.data) == {"detail", "code"}
    assert response.data["code"] == "conflict"
    assert "slot_secret_idx" not in str(response.data)


def test_protected_error_is_409_without_object_dump():
    response = handle(ProtectedError("protected: <Booking: leaked-repr>", {object()}))
    assert response.status_code == 409
    assert "leaked-repr" not in str(response.data)


def test_object_does_not_exist_is_404():
    response = handle(Slot.DoesNotExist("Slot matching query does not exist. internal"))
    assert response.status_code == 404
    assert response.data["code"] == "not_found"
    assert "internal" not in str(response.data)


def test_plain_object_does_not_exist_is_404():
    assert handle(ObjectDoesNotExist("x")).status_code == 404


def test_unrelated_exceptions_are_untouched():
    assert handle(RuntimeError("boom")) is None


def test_exception_types_are_logged_not_messages(caplog):
    with caplog.at_level("WARNING"):
        handle(IntegrityError(SECRET))
    assert "slot_secret_idx" not in caplog.text
    assert "IntegrityError" in caplog.text


def test_parallel_delete_surfaces_as_404_over_http(admin_user, slot_a):
    client = client_for(admin_user)
    with mock.patch.object(services, "_lock_lot", side_effect=Slot.DoesNotExist("gone")):
        response = client.patch(f"/api/v1/admin/slots/{slot_a.id}", {"distance_to_entrance": 3})
    assert response.status_code == 404
    assert response.data["code"] == "not_found"


def test_unexpected_integrity_error_over_http_is_409(admin_user, zone_a):
    client = client_for(admin_user)
    with mock.patch.object(Slot.objects, "create", side_effect=IntegrityError(SECRET)):
        response = client.post(
            "/api/v1/admin/slots", {"zone": str(zone_a.id), "code": "Z-1"}, format="json"
        )
    assert response.status_code == 409
    assert "slot_secret_idx" not in str(response.data)
