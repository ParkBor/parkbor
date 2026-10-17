"""/api/v1 booking endpoints: contract (ARCHITECTURE 9.4), scoping, errors, throttling."""

from datetime import timedelta
from decimal import Decimal

import pytest

from apps.bookings import qr
from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from tests.bookings.factories import make_booking, make_vehicle
from tests.helpers import client_for, make_user

pytestmark = pytest.mark.django_db

KEY = "7c1e5d6a-1111-4222-8333-944455556666"


def iso(dt):
    return dt.isoformat()


@pytest.fixture
def payload(world, vehicle, window):
    return {
        "parking_lot_id": str(world.lot.pk),
        "slot_type": "STANDARD",
        "vehicle_id": str(vehicle.pk),
        "start": iso(window[0]),
        "end": iso(window[1]),
        "preferred_slot_id": None,
    }


def post(api, payload, key=KEY, **extra):
    headers = {} if key is None else {"HTTP_IDEMPOTENCY_KEY": key}
    return api.post("/api/v1/bookings", payload, format="json", **headers, **extra)


class TestCreateContract:
    def test_201_shape_matches_the_documented_contract(self, api, payload, world):
        res = post(api, payload)
        assert res.status_code == 201
        body = res.json()
        assert set(body) == {
            "id",
            "status",
            "slot",
            "parking_lot",
            "vehicle",
            "start",
            "end",
            "amount",
            "paid_amount",
            "refund_amount",
            "hold_expires_at",
            "payment_provider",
            "payment_url",
            "refund_status",
            "checked_in_at",
            "checked_out_at",
            "cancelled_at",
            "created_at",
        }
        assert body["status"] == "PENDING_PAYMENT"
        assert set(body["slot"]) == {"id", "code", "zone", "floor"}
        assert body["slot"]["zone"] == "A"
        assert body["slot"]["floor"] == 1
        assert body["amount"] == "12000.00"
        assert body["refund_amount"] == "0.00"
        assert body["payment_provider"] == "payme"  # the configured default
        assert body["payment_url"].startswith("https://")  # details: tests/payments
        assert body["hold_expires_at"] is not None
        assert body["parking_lot"]["id"] == str(world.lot.pk)
        assert body["vehicle"]["plate_number"]
        assert body["start"].endswith("+05:00")  # Asia/Tashkent

    def test_the_booking_belongs_to_the_caller(self, api, driver, payload):
        res = post(api, payload)
        assert Booking.objects.get(pk=res.json()["id"]).user == driver

    def test_preferred_slot(self, api, payload, world):
        payload["preferred_slot_id"] = str(world.slots[2].pk)
        assert post(api, payload).json()["slot"]["id"] == str(world.slots[2].pk)

    def test_anonymous_is_401(self, client, payload):
        res = client.post(
            "/api/v1/bookings", payload, content_type="application/json", HTTP_IDEMPOTENCY_KEY=KEY
        )
        assert res.status_code == 401


class TestCreateErrors:
    def test_missing_idempotency_key_is_400(self, api, payload):
        res = post(api, payload, key=None)
        assert res.status_code == 400
        assert res.json()["code"] == "idempotency_key_required"

    def test_malformed_idempotency_key_is_400(self, api, payload):
        res = post(api, payload, key="bad key!")
        assert res.status_code == 400
        assert res.json()["code"] == "idempotency_key_invalid"

    @pytest.mark.parametrize(
        ("field", "value"),
        [
            ("start", "2026-10-15T14:00:00"),  # no UTC offset
            ("start", "tomorrow"),
            ("end", None),
            ("slot_type", "VIP"),
            ("parking_lot_id", "nope"),
            ("vehicle_id", None),
        ],
    )
    def test_malformed_body_is_400(self, api, payload, field, value):
        payload[field] = value
        assert post(api, payload).status_code == 400

    def test_missing_field_is_400(self, api, payload):
        del payload["end"]
        assert post(api, payload).status_code == 400

    def test_rule_violation_is_422_with_a_code(self, api, payload, window):
        payload["end"] = iso(window[0] + timedelta(minutes=10))
        res = post(api, payload)
        assert res.status_code == 422
        assert res.json()["code"] == "period_too_short"

    def test_foreign_vehicle_is_422(self, api, payload):
        payload["vehicle_id"] = str(make_vehicle(make_user("DRIVER")).pk)
        res = post(api, payload)
        assert res.status_code == 422
        assert res.json()["code"] == "vehicle_not_found"

    def test_unknown_lot_is_404(self, api, payload):
        payload["parking_lot_id"] = "00000000-0000-4000-8000-000000000000"
        assert post(api, payload).status_code == 404

    def test_no_free_slot_is_409(self, api, payload, world):
        for _ in world.slots:
            other = make_user("DRIVER")
            res = post(
                client_for(other),
                {**payload, "vehicle_id": str(make_vehicle(other).pk)},
                key=f"other-{other.pk}",
            )
            assert res.status_code == 201
        res = post(api, payload)
        assert res.status_code == 409
        assert res.json()["code"] == "no_slot_available"


class TestIdempotencyOverHttp:
    def test_repeat_returns_the_same_booking_and_flags_the_replay(self, api, payload):
        first = post(api, payload)
        second = post(api, payload)
        assert (first.status_code, second.status_code) == (201, 200)
        assert second.json()["id"] == first.json()["id"]
        assert second["Idempotent-Replayed"] == "true"
        assert Booking.objects.count() == 1

    def test_same_key_other_payload_is_422(self, api, payload, window):
        post(api, payload)
        payload["end"] = iso(window[1] + timedelta(hours=1))
        res = post(api, payload)
        assert res.status_code == 422
        assert res.json()["code"] == "idempotency_conflict"

    def test_a_different_key_makes_a_second_booking(self, api, driver, payload, window):
        post(api, payload)
        second = {**payload, "vehicle_id": str(make_vehicle(driver).pk)}
        assert post(api, second, key="another-key-12345").status_code == 201
        assert Booking.objects.count() == 2

    def test_the_same_car_cannot_hold_two_slots_at_once(self, api, payload):
        post(api, payload)
        res = post(api, payload, key="another-key-12345")
        assert res.status_code == 409
        assert res.json()["code"] == "vehicle_busy"

    def test_a_lot_owner_is_refused_with_422(self, payload, world):
        owner = world.owner
        res = post(client_for(owner), {**payload, "vehicle_id": str(make_vehicle(owner).pk)})
        assert res.status_code == 422
        assert res.json()["code"] == "own_lot_booking"

    def test_responses_are_not_cacheable(self, api, payload):
        res = post(api, payload)
        assert res["Cache-Control"] == "no-store"
        assert api.get("/api/v1/bookings")["Cache-Control"] == "no-store"
        assert api.get(f"/api/v1/bookings/{res.json()['id']}")["Cache-Control"] == "no-store"

    def test_the_plate_is_the_one_recorded_at_booking_time(self, api, driver, payload, vehicle):
        booking_id = post(api, payload).json()["id"]
        old_plate = vehicle.plate_number
        from apps.vehicles.models import Vehicle

        Vehicle.objects.filter(pk=vehicle.pk).update(plate_number="01Z999ZZ")
        body = api.get(f"/api/v1/bookings/{booking_id}").json()
        assert body["vehicle"]["plate_number"] == old_plate


class TestOtherThrottleScopes:
    def test_cancel_has_its_own_limit_of_20_per_minute(self, api, mine):
        booking = mine()
        url = f"/api/v1/bookings/{booking.pk}/cancel"
        codes = [api.post(url).status_code for _ in range(21)]
        assert codes[0] == 200 and 429 not in codes[:20]
        assert codes[20] == 429

    def test_qr_has_its_own_limit_of_30_per_minute(self, api, mine):
        url = f"/api/v1/bookings/{mine().pk}/qr"
        codes = [api.get(url).status_code for _ in range(31)]
        assert 429 not in codes[:30]
        assert codes[30] == 429

    def test_reading_is_not_eaten_by_the_mutation_budget(self, api, mine):
        booking = mine()
        for _ in range(20):
            api.post(f"/api/v1/bookings/{booking.pk}/cancel")
        assert api.get(f"/api/v1/bookings/{booking.pk}").status_code == 200


class TestThrottle:
    def test_ten_creates_per_minute_per_user(self, api, payload):
        statuses = [post(api, payload, key=f"key-number-{n:04d}").status_code for n in range(10)]
        assert 429 not in statuses
        assert post(api, payload, key="key-number-9999").status_code == 429


@pytest.fixture
def mine(driver, vehicle, world, now):
    def build(status=S.CONFIRMED, start_min=120, length_min=120, slot=0, **extra):
        start = now + timedelta(minutes=start_min)
        return make_booking(
            user=driver,
            slot=world.slots[slot],
            vehicle=vehicle,
            start=start,
            end=start + timedelta(minutes=length_min),
            status=status,
            **extra,
        )

    return build


class TestListAndRetrieve:
    def test_only_my_bookings(self, api, mine, world):
        wanted = mine()
        other = make_user("DRIVER")
        make_booking(
            user=other,
            slot=world.slots[1],
            vehicle=make_vehicle(other),
            start=wanted.starts_at,
            end=wanted.ends_at,
        )
        body = api.get("/api/v1/bookings").json()
        assert [b["id"] for b in body["results"]] == [str(wanted.pk)]
        assert body["count"] == 1

    def test_paginated(self, api, mine):
        for n in range(3):
            mine(start_min=120 + n * 300, slot=n % 3)
        body = api.get("/api/v1/bookings?page_size=2").json()
        assert body["count"] == 3
        assert len(body["results"]) == 2
        assert body["next"]

    def test_status_filter(self, api, mine):
        mine(S.CONFIRMED)
        mine(S.CANCELLED, start_min=600, slot=1)
        ids = api.get("/api/v1/bookings?status=CANCELLED").json()["results"]
        assert [b["status"] for b in ids] == ["CANCELLED"]
        both = api.get("/api/v1/bookings?status=CANCELLED,CONFIRMED").json()["count"]
        assert both == 2

    def test_unknown_status_is_400(self, api):
        assert api.get("/api/v1/bookings?status=NOPE").status_code == 400

    @pytest.mark.parametrize(
        ("scope", "expected"),
        [
            ("active", {S.ACTIVE, S.OVERSTAY}),
            ("upcoming", {S.PENDING_PAYMENT, S.CONFIRMED}),
            ("history", {S.COMPLETED, S.CANCELLED, S.EXPIRED, S.NO_SHOW}),
        ],
    )
    def test_scopes(self, api, mine, world, scope, expected):
        for i, status in enumerate(S):
            mine(status, start_min=60 + i * 300, slot=i % 3)
        got = {b["status"] for b in api.get(f"/api/v1/bookings?scope={scope}").json()["results"]}
        assert got == {str(s) for s in expected}

    def test_upcoming_is_soonest_first_and_history_newest_first(self, api, mine):
        late = mine(S.CONFIRMED, start_min=1000)
        soon = mine(S.CONFIRMED, start_min=100, slot=1)
        up = [b["id"] for b in api.get("/api/v1/bookings?scope=upcoming").json()["results"]]
        assert up == [str(soon.pk), str(late.pk)]

    def test_unknown_scope_is_400(self, api):
        assert api.get("/api/v1/bookings?scope=never").status_code == 400

    def test_retrieve_own(self, api, mine):
        booking = mine()
        res = api.get(f"/api/v1/bookings/{booking.pk}")
        assert res.status_code == 200
        assert res.json()["id"] == str(booking.pk)

    def test_foreign_booking_is_404_everywhere(self, mine):
        booking = mine()
        stranger = client_for(make_user("DRIVER"))
        base = f"/api/v1/bookings/{booking.pk}"
        assert stranger.get(base).status_code == 404
        assert stranger.post(f"{base}/cancel").status_code == 404
        assert stranger.get(f"{base}/cancel-preview").status_code == 404
        assert (
            stranger.post(
                f"{base}/extend", {"end": iso(booking.ends_at)}, format="json"
            ).status_code
            == 404
        )
        assert stranger.get(f"{base}/qr").status_code == 404

    def test_anonymous_is_401(self, client, mine):
        assert client.get(f"/api/v1/bookings/{mine().pk}").status_code == 401

    def test_unknown_id_is_404(self, api):
        assert api.get("/api/v1/bookings/00000000-0000-4000-8000-000000000000").status_code == 404


class TestCancelOverHttp:
    def test_cancel_returns_the_booking_with_the_refund(self, api, mine):
        booking = mine(start_min=30)
        res = api.post(f"/api/v1/bookings/{booking.pk}/cancel")
        assert res.status_code == 200
        assert res.json()["status"] == "CANCELLED"
        assert res.json()["refund_amount"] == "6000.00"
        assert res.json()["cancelled_at"]

    def test_preview(self, api, mine):
        booking = mine(start_min=30)
        res = api.get(f"/api/v1/bookings/{booking.pk}/cancel-preview")
        assert res.json() == {"can_cancel": True, "refund_percent": 50, "refund_amount": "6000.00"}
        assert Booking.objects.get(pk=booking.pk).status == S.CONFIRMED  # preview changes nothing

    def test_cancelling_a_completed_booking_is_409(self, api, mine):
        booking = mine(S.COMPLETED)
        res = api.post(f"/api/v1/bookings/{booking.pk}/cancel")
        assert res.status_code == 409
        assert res.json()["code"] == "invalid_transition"


class TestExtendDisabled:
    def test_409_extend_unavailable_until_payments_exist(self, api, mine):
        booking = mine()
        res = api.post(
            f"/api/v1/bookings/{booking.pk}/extend",
            {"end": iso(booking.ends_at + timedelta(hours=1))},
            format="json",
        )
        assert res.status_code == 409
        assert res.json()["code"] == "extend_unavailable"
        assert Booking.objects.get(pk=booking.pk).ends_at == booking.ends_at


@pytest.fixture
def extension_on(settings):
    settings.BOOKING_EXTEND_ENABLED = True


@pytest.mark.usefixtures("extension_on")
class TestExtendOverHttp:
    def test_extend(self, api, mine):
        booking = mine()
        new_end = booking.ends_at + timedelta(hours=1)
        res = api.post(
            f"/api/v1/bookings/{booking.pk}/extend", {"end": iso(new_end)}, format="json"
        )
        assert res.status_code == 200
        body = res.json()
        assert body["extra_amount"] == "6000.00"
        assert body["amount"] == "18000.00"
        assert Booking.objects.get(pk=booking.pk).ends_at == new_end

    def test_conflict_is_409(self, api, mine):
        booking = mine()
        mine(slot=0, start_min=250, length_min=60)
        res = api.post(
            f"/api/v1/bookings/{booking.pk}/extend",
            {"end": iso(booking.ends_at + timedelta(hours=2))},
            format="json",
        )
        assert res.status_code == 409
        assert res.json()["code"] == "booking_conflict"

    def test_missing_end_is_400(self, api, mine):
        assert (
            api.post(f"/api/v1/bookings/{mine().pk}/extend", {}, format="json").status_code == 400
        )

    def test_naive_end_is_400(self, api, mine):
        res = api.post(
            f"/api/v1/bookings/{mine().pk}/extend", {"end": "2030-01-01T10:00:00"}, format="json"
        )
        assert res.status_code == 400


class TestQrOverHttp:
    @pytest.mark.parametrize(
        ("status", "purpose"),
        [(S.CONFIRMED, "entry"), (S.ACTIVE, "exit"), (S.OVERSTAY, "exit")],
    )
    def test_owner_gets_a_verifiable_token(self, api, mine, status, purpose, now):
        booking = mine(status, start_min=120 if status == S.CONFIRMED else -10)
        res = api.get(f"/api/v1/bookings/{booking.pk}/qr")
        assert res.status_code == 200
        assert res["Cache-Control"] == "no-store"
        body = res.json()
        assert set(body) == {"qr_token", "expires_at", "purpose"}
        assert body["purpose"] == purpose
        claims = qr.verify_token(body["qr_token"], expected_purpose=purpose, now=now)
        assert claims.booking_id == booking.pk

    @pytest.mark.parametrize(
        "status", [S.PENDING_PAYMENT, S.COMPLETED, S.CANCELLED, S.EXPIRED, S.NO_SHOW]
    )
    def test_other_states_are_409(self, api, mine, status):
        res = api.get(f"/api/v1/bookings/{mine(status).pk}/qr")
        assert res.status_code == 409
        assert res.json()["code"] == "qr_not_available"


class TestAvailabilityAndPrice:
    def url(self, world, what, window, **extra):
        query = f"from={iso(window[0])}&to={iso(window[1])}"
        for k, v in extra.items():
            query += f"&{k}={v}"
        return f"/api/v1/parkings/{world.lot.pk}/{what}?{query.replace('+', '%2B')}"

    def test_availability_counts_free_slots(self, api, world, window, payload):
        post(api, payload)
        res = api.get(self.url(world, "availability", window, slot_type="STANDARD"))
        assert res.status_code == 200
        assert res.json() == {
            "slot_type": "STANDARD",
            "start": res.json()["start"],
            "end": res.json()["end"],
            "total": 3,
            "available": 2,
            "is_open": True,
        }

    def test_availability_without_a_type_counts_everything(self, api, world, window):
        assert api.get(self.url(world, "availability", window)).json()["total"] == 3

    def test_availability_other_window_is_unaffected(self, api, world, window, payload):
        post(api, payload)
        later = (window[0] + timedelta(days=1), window[1] + timedelta(days=1))
        assert api.get(self.url(world, "availability", later)).json()["available"] == 3

    def test_availability_bad_params_are_400(self, api, world, window):
        assert api.get(f"/api/v1/parkings/{world.lot.pk}/availability").status_code == 400
        res = api.get(self.url(world, "availability", window, slot_type="VIP"))
        assert res.status_code == 400

    def test_availability_of_an_unknown_or_inactive_lot_is_404(self, api, window):
        res = api.get(
            f"/api/v1/parkings/00000000-0000-4000-8000-000000000000/availability"
            f"?from={iso(window[0]).replace('+', '%2B')}&to={iso(window[1]).replace('+', '%2B')}"
        )
        assert res.status_code == 404

    def test_price_breakdown(self, api, world, window):
        res = api.get(self.url(world, "price", window, slot_type="STANDARD"))
        assert res.status_code == 200
        body = res.json()
        assert body["price_per_hour"] == "6000.00"
        assert body["total_minutes"] == 120
        assert body["free_minutes"] == 10
        assert body["billed_minutes"] == 120
        assert body["subtotal"] == "12000.00"
        assert body["dynamic_factor"] == "1"
        assert body["total"] == "12000.00"
        assert body["available_slots"] == 3
        (segment,) = body["segments"]
        assert segment["minutes"] == 120
        assert segment["coefficient"] == "1"
        assert segment["amount"] == "12000.00"
        assert Decimal(body["total"]) == sum(Decimal(s["amount"]) for s in body["segments"])

    def test_price_requires_a_slot_type(self, api, world, window):
        assert api.get(self.url(world, "price", window)).status_code == 400

    def test_price_for_a_type_without_a_tariff_is_422(self, api, world, window):
        res = api.get(self.url(world, "price", window, slot_type="EV"))
        assert res.status_code == 422
        assert res.json()["code"] == "no_tariff"

    def test_price_matches_what_a_booking_then_costs(self, api, world, window, payload):
        quoted = api.get(self.url(world, "price", window, slot_type="STANDARD")).json()["total"]
        assert post(api, payload).json()["amount"] == quoted

    def test_an_unencoded_plus_in_the_offset_is_a_400_so_clients_must_send_percent_2B(
        self, api, world, window
    ):
        """In a query string a literal '+' means a space: '+05:00' arrives as ' 05:00'."""
        url = f"/api/v1/parkings/{world.lot.pk}/availability?from={iso(window[0])}&to={iso(window[1])}"
        assert "+" in url
        assert api.get(url).status_code == 400
        assert api.get(url.replace("+", "%2B")).status_code == 200

    def test_utc_z_notation_needs_no_encoding(self, api, world, window):
        from datetime import UTC

        start, end = (w.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ") for w in window)
        res = api.get(f"/api/v1/parkings/{world.lot.pk}/availability?from={start}&to={end}")
        assert res.status_code == 200

    def test_anonymous_is_401(self, client, world, window):
        assert client.get(self.url(world, "price", window, slot_type="STANDARD")).status_code == 401


def test_openapi_schema_has_zero_warnings():
    import os

    from django.core.management import call_command

    call_command("spectacular", "--fail-on-warn", "--file", os.devnull)
