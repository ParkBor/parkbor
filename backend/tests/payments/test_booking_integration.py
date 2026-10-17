"""Step 8a contract with the booking API: `payment_provider` in, `payment_url` out."""

from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

import pytest

from apps.bookings.models import Booking
from apps.bookings.state import BookingStatus as S
from apps.bookings.state import status_write_allowed
from apps.payments import checkout, services, tasks
from apps.payments.models import Refund
from tests.bookings.factories import make_vehicle, make_world
from tests.helpers import client_for, make_user
from tests.payments.factories import payme_id

pytestmark = pytest.mark.django_db
KEY = "7c1e5d6a-1111-4222-8333-944455556666"


@pytest.fixture
def api(driver):
    return client_for(driver)


@pytest.fixture
def window(now):
    return now + timedelta(hours=1), now + timedelta(hours=3)


@pytest.fixture
def payload(world, vehicle, window):
    return {
        "parking_lot_id": str(world.lot.pk),
        "slot_type": "STANDARD",
        "vehicle_id": str(vehicle.pk),
        "start": window[0].isoformat(),
        "end": window[1].isoformat(),
    }


def post(api, payload, key=KEY):
    return api.post("/api/v1/bookings", payload, format="json", HTTP_IDEMPOTENCY_KEY=key)


class TestCreate:
    def test_default_provider_gives_a_payme_link(self, api, payload):
        body = post(api, payload).json()
        assert body["payment_provider"] == "payme"
        assert body["payment_url"].startswith("https://test.paycom.uz/")  # sandbox in tests

    def test_click_can_be_chosen(self, api, payload):
        body = post(api, {**payload, "payment_provider": "click"}).json()
        url = urlsplit(body["payment_url"])
        assert body["payment_provider"] == "click"
        assert f"{url.scheme}://{url.netloc}{url.path}" == "https://my.click.uz/services/pay"
        assert parse_qs(url.query)["transaction_param"] == [body["id"]]
        assert Booking.objects.get(pk=body["id"]).payment_provider == "click"

    def test_configured_default_is_used_when_omitted(self, api, payload, settings):
        settings.PAYMENTS_DEFAULT_PROVIDER = "click"
        assert post(api, payload).json()["payment_provider"] == "click"

    def test_null_means_default(self, api, payload):
        assert (
            post(api, {**payload, "payment_provider": None}).json()["payment_provider"] == "payme"
        )

    @pytest.mark.parametrize("value", ["stripe", "PAYME", "", 5, ["click"]])
    def test_unknown_provider_is_a_400(self, api, payload, value):
        response = post(api, {**payload, "payment_provider": value})
        assert response.status_code == 400
        assert not Booking.objects.exists()

    def test_no_secret_is_in_the_response(self, api, payload):
        from tests.payments.click_helpers import SECRET
        from tests.payments.payme_helpers import KEY as PAYME_KEY

        for provider in ("payme", "click"):
            text = post(
                api, {**payload, "payment_provider": provider}, key=f"{KEY}-{provider}"
            ).text
            assert SECRET not in text and PAYME_KEY not in text

    def test_replay_with_the_default_spelled_out_is_the_same_request(self, api, payload):
        first = post(api, payload)
        again = post(api, {**payload, "payment_provider": "payme"})
        assert first.status_code == 201 and again.status_code == 200
        assert again.json()["id"] == first.json()["id"]

    def test_replay_with_another_provider_is_a_conflict(self, api, payload):
        post(api, payload)
        response = post(api, {**payload, "payment_provider": "click"})
        assert response.status_code == 422
        assert response.json()["code"] == "idempotency_conflict"


class TestRead:
    def create(self, api, payload):
        return post(api, payload).json()["id"]

    def test_pending_booking_keeps_its_link_on_reload(self, api, payload):
        booking_id = self.create(api, {**payload, "payment_provider": "click"})
        body = api.get(f"/api/v1/bookings/{booking_id}").json()
        assert body["payment_url"].startswith("https://my.click.uz/services/pay?")

    def test_list_carries_the_link_too(self, api, payload):
        self.create(api, payload)
        results = api.get("/api/v1/bookings").json()["results"]
        assert results[0]["payment_url"]

    @pytest.mark.parametrize("status", [S.CONFIRMED, S.CANCELLED, S.EXPIRED])
    def test_no_link_once_it_cannot_be_paid(self, api, payload, status):
        booking_id = self.create(api, payload)
        with status_write_allowed():
            Booking.objects.filter(pk=booking_id).update(status=status)
        assert api.get(f"/api/v1/bookings/{booking_id}").json()["payment_url"] is None

    def test_no_link_after_the_hold_ran_out(self, api, payload):
        booking_id = self.create(api, payload)
        Booking.objects.filter(pk=booking_id).update(
            hold_expires_at=Booking.objects.get(pk=booking_id).created_at - timedelta(minutes=1)
        )
        assert api.get(f"/api/v1/bookings/{booking_id}").json()["payment_url"] is None

    def test_old_bookings_without_a_provider_use_the_default(self, api, payload):
        booking_id = self.create(api, payload)
        Booking.objects.filter(pk=booking_id).update(payment_provider="")
        body = api.get(f"/api/v1/bookings/{booking_id}").json()
        assert body["payment_url"].startswith("https://test.paycom.uz/")
        assert body["payment_provider"] == ""

    def test_unconfigured_provider_gives_no_link(self, api, payload, settings):
        booking_id = self.create(api, payload)
        settings.PAYME_MERCHANT_ID = ""  # credentials vanish after the booking was made
        assert api.get(f"/api/v1/bookings/{booking_id}").json()["payment_url"] is None

    def test_unknown_stored_provider_gives_no_link(self, booking):
        Booking.objects.filter(pk=booking.pk).update(payment_provider="stripe")
        booking.refresh_from_db()
        assert checkout.payment_url_for(booking) is None


class TestCancelRefundsThroughTheApi:
    def test_cancelling_a_paid_booking_creates_and_queues_the_refund(
        self, api, driver, booking, now, monkeypatch, django_capture_on_commit_callbacks
    ):
        sent = []
        monkeypatch.setattr(tasks.send_refund, "apply_async", lambda *a, **k: sent.append(a))
        payment = services.register_transaction(
            booking_id=booking.pk,
            provider="payme",
            external_id=payme_id(),
            amount=booking.amount,
            now=now,
        ).payment
        services.complete_payment(provider="payme", external_id=payment.external_id, now=now)
        with django_capture_on_commit_callbacks(execute=True):
            response = api.post(f"/api/v1/bookings/{booking.pk}/cancel")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "CANCELLED" and body["refund_amount"] == "12000.00"
        assert Refund.objects.get().amount == booking.amount
        assert len(sent) == 1


def test_world_fixtures_are_independent(db):
    assert make_world(slots=1) is not None
    assert make_vehicle(make_user("DRIVER")) is not None


class TestRefundStatus:
    """`refund_status` tells the app what really happens to `refund_amount` (a promise, not a
    payment): none | pending | done | manual | failed."""

    def paid_booking(self, booking, now, status=None):
        from apps.payments.models import PaymentStatus
        from tests.payments.factories import make_payment, make_refund

        payment = make_payment(booking, status=PaymentStatus.PAID, performed_at=now)
        refunds = [
            make_refund(payment, status=s, amount="1", key=f"k{i}-{booking.pk}")
            for i, s in enumerate(status or [])
        ]
        return payment, refunds

    @pytest.mark.parametrize(
        "statuses, expected",
        [
            ([], "none"),
            (["PENDING"], "pending"),
            (["SENT"], "pending"),
            (["DONE"], "done"),
            (["MANUAL"], "manual"),
            (["FAILED"], "failed"),
            (["DONE", "MANUAL"], "manual"),
            (["PENDING", "DONE"], "pending"),
            (["MANUAL", "FAILED"], "failed"),
        ],
    )
    def test_value(self, api, booking, now, statuses, expected):
        self.paid_booking(booking, now, statuses)
        body = api.get(f"/api/v1/bookings/{booking.pk}").json()
        assert body["refund_status"] == expected

    def test_list_does_not_query_per_booking(
        self, api, booking, make_pending, now, django_assert_max_num_queries
    ):
        for other in (booking, make_pending(), make_pending()):
            self.paid_booking(other, now, ["MANUAL"])
        with django_assert_max_num_queries(12):
            results = api.get("/api/v1/bookings").json()["results"]
        assert {row["refund_status"] for row in results} == {"manual"}


class TestUnavailableAndFreeBookings:
    def test_a_provider_without_credentials_cannot_be_chosen(self, api, payload, settings):
        settings.CLICK_SERVICE_ID = ""
        response = post(api, {**payload, "payment_provider": "click"})
        assert response.status_code == 422
        assert response.json()["code"] == "payment_provider_unavailable"
        assert not Booking.objects.exists()

    def test_the_unconfigured_default_is_refused_too(self, api, payload, settings):
        settings.PAYME_MERCHANT_ID = ""
        response = post(api, payload)
        assert response.status_code == 422
        assert response.json()["code"] == "payment_provider_unavailable"

    def test_the_other_provider_still_works(self, api, payload, settings):
        settings.PAYME_MERCHANT_ID = ""
        assert post(api, {**payload, "payment_provider": "click"}).status_code == 201

    def test_a_free_booking_is_refused_because_nothing_could_be_paid(self, api, payload, world):
        from apps.parking.models import Tariff

        Tariff.objects.filter(parking_lot=world.lot).update(price_per_hour=0)
        response = post(api, payload)
        assert response.status_code == 422
        assert response.json()["code"] == "price_zero"
        assert not Booking.objects.exists()

    def test_a_zero_amount_booking_never_breaks_the_read_path(self, api, booking):
        Booking.objects.filter(pk=booking.pk).update(amount=0)
        response = api.get(f"/api/v1/bookings/{booking.pk}")
        assert response.status_code == 200 and response.json()["payment_url"] is None
