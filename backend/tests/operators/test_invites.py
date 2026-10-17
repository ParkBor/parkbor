"""POST /me/operator-invites/accept: becoming an operator with the owner's one-time code."""

import logging
from datetime import timedelta

import pytest
from django.core.cache import cache
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.operators import services as operator_services
from apps.parking.models import LotStatus, OperatorAssignment, OperatorInvite, ParkingLot
from tests.helpers import client_for, make_lot, make_user

pytestmark = pytest.mark.django_db

ACCEPT = "/api/v1/me/operator-invites/accept"


@pytest.fixture
def owner():
    return make_user("OWNER")


@pytest.fixture
def lot(owner):
    return make_lot(owner, "Gate Lot", status=LotStatus.ACTIVE)


def invite(lot, owner, **kwargs):
    return operator_services.create_invite(lot=lot, actor=owner, **kwargs)


def accept(user, code):
    return client_for(user).post(ACCEPT, {"code": code}, format="json")


# --- the happy path ---------------------------------------------------------------------------


def test_a_driver_becomes_an_operator_of_exactly_that_lot(lot, owner):
    row, code = invite(lot, owner)
    staff = make_user("DRIVER")

    response = accept(staff, code)

    assert response.status_code == 200
    assert response.json() == {"parking_lot": {"id": str(lot.id), "name": "Gate Lot"}}
    assert response["Cache-Control"] == "no-store"
    staff.refresh_from_db()
    assert staff.role == User.Role.OPERATOR
    assignment = OperatorAssignment.objects.get(operator=staff)
    assert (assignment.parking_lot_id, assignment.created_by_id) == (lot.id, owner.id)
    row.refresh_from_db()
    assert (row.used_by_id, row.used_at is not None) == (staff.id, True)


def test_the_code_may_be_typed_in_any_case_with_spaces_or_dashes(lot, owner):
    _row, code = invite(lot, owner)
    sloppy = " " + code.lower().replace("-", " ") + " "

    assert accept(make_user("DRIVER"), sloppy).status_code == 200


def test_an_operator_can_join_a_second_lot_and_keeps_the_role(lot, owner):
    staff = make_user("DRIVER")
    accept(staff, invite(lot, owner)[1])
    other = make_lot(owner, "Second", status=LotStatus.ACTIVE)

    assert accept(staff, invite(other, owner)[1]).status_code == 200

    assert OperatorAssignment.objects.filter(operator=staff, revoked_at__isnull=True).count() == 2


def test_accepting_is_audited_in_the_database_without_the_code(lot, owner):
    _row, code = invite(lot, owner)
    staff = make_user("DRIVER")

    accept(staff, code)

    row = AuditLog.objects.get(action="operator.invite_accept")
    assert row.actor_id == staff.id
    assert row.meta["after"] == {"lot": str(lot.id), "role_promoted": True}
    assert code.replace("-", "") not in str(AuditLog.objects.values_list("meta", flat=True))


# --- every refusal looks the same -------------------------------------------------------------


def refusal_cases(lot, owner):
    """(name, user, code) for each reason a code cannot be used."""
    fresh = make_user("DRIVER")
    cases = {}
    cases["wrong"] = (fresh, "ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z")
    cases["garbage"] = (fresh, "not a code at all")
    expired = invite(lot, owner, now=timezone.now() - timedelta(days=30))[1]
    cases["expired"] = (fresh, expired)
    used_code = invite(lot, owner)[1]
    accept(make_user("DRIVER"), used_code)
    cases["used"] = (fresh, used_code)
    revoked_row, revoked_code = invite(lot, owner)
    operator_services.revoke_invite(lot=lot, invite_id=revoked_row.pk, actor=owner)
    cases["revoked"] = (fresh, revoked_code)
    cases["owner_account"] = (make_user("OWNER"), invite(lot, owner)[1])
    cases["admin_account"] = (make_user("ADMIN"), invite(lot, owner)[1])
    suspended = make_lot(owner, "Suspended", status=LotStatus.SUSPENDED)
    cases["lot_not_active"] = (fresh, invite(suspended, owner)[1])
    pending = make_lot(owner, "Pending")
    cases["lot_in_review"] = (fresh, invite(pending, owner)[1])
    return cases


def test_all_refusals_are_the_same_400_with_the_same_body(lot, owner):
    bodies = {}
    for name, (user, code) in refusal_cases(lot, owner).items():
        cache.clear()  # the wrong-code counter is not what this test is about
        response = accept(user, code)
        bodies[name] = (response.status_code, response.json())

    expected = (400, {"detail": "This invitation code is not valid.", "code": "invite_invalid"})
    assert all(outcome == expected for outcome in bodies.values()), bodies


def test_an_inactive_account_gets_the_same_answer(lot, owner):
    staff = make_user("DRIVER", is_active=False)
    code = invite(lot, owner)[1]

    # a disabled account cannot authenticate at all; the service refuses it the same way
    with pytest.raises(operator_services.InviteInvalid):
        operator_services.accept_invite(user=staff, code=code)


def test_an_owner_trying_a_code_does_not_burn_it(lot, owner):
    _row, code = invite(lot, owner)
    accept(make_user("OWNER"), code)
    accept(make_user("ADMIN"), code)

    assert accept(make_user("DRIVER"), code).status_code == 200


def test_roles_of_owner_and_admin_are_never_changed(lot, owner):
    stranger_owner = make_user("OWNER")
    admin = make_user("ADMIN")
    code = invite(lot, owner)[1]

    accept(stranger_owner, code)
    accept(admin, code)

    for user, role in ((stranger_owner, "OWNER"), (admin, "ADMIN")):
        user.refresh_from_db()
        assert user.role == role
    assert not OperatorAssignment.objects.exists()


def test_a_code_works_once_only(lot, owner):
    _row, code = invite(lot, owner)

    assert accept(make_user("DRIVER"), code).status_code == 200
    assert accept(make_user("DRIVER"), code).status_code == 400


def test_the_same_person_accepting_twice_changes_nothing_the_second_time(lot, owner):
    staff = make_user("DRIVER")
    _row, code = invite(lot, owner)
    accept(staff, code)

    assert accept(staff, code).status_code == 400
    assert OperatorAssignment.objects.filter(operator=staff).count() == 1


def test_the_boundary_second_of_expiry_is_already_expired(lot, owner):
    row, code = invite(lot, owner)

    with pytest.raises(operator_services.InviteInvalid):
        operator_services.accept_invite(user=make_user("DRIVER"), code=code, now=row.expires_at)
    assert (
        operator_services.accept_invite(
            user=make_user("DRIVER"), code=code, now=row.expires_at - timedelta(seconds=1)
        ).pk
        == lot.pk
    )


def test_a_lot_suspended_after_the_invitation_makes_the_code_useless(lot, owner):
    _row, code = invite(lot, owner)
    ParkingLot.objects.filter(pk=lot.pk).update(status=LotStatus.SUSPENDED)

    assert accept(make_user("DRIVER"), code).status_code == 400
    assert not OperatorAssignment.objects.exists()


# --- guessing ---------------------------------------------------------------------------------


def test_five_wrong_codes_lock_the_account_out_and_even_a_right_code_waits(lot, owner):
    staff = make_user("DRIVER")
    good = invite(lot, owner)[1]

    codes = [accept(staff, "ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z").status_code for _ in range(6)]
    locked = accept(staff, good)

    assert codes == [400, 400, 400, 400, 400, 429]
    assert (locked.status_code, locked.json()["code"]) == (429, "invite_locked")
    assert int(locked["Retry-After"]) >= 1
    assert not OperatorAssignment.objects.exists()


def test_the_lock_is_per_account(lot, owner):
    guesser = make_user("DRIVER")
    for _ in range(6):
        accept(guesser, "ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z")

    assert accept(make_user("DRIVER"), invite(lot, owner)[1]).status_code == 200


def test_the_moment_of_locking_is_audited_once(
    lot, owner, caplog, django_capture_on_commit_callbacks
):
    staff = make_user("DRIVER")

    with (
        caplog.at_level(logging.INFO, logger="habi.audit"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        for _ in range(8):
            accept(staff, "ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z")

    assert AuditLog.objects.filter(action="operator.invite_locked").count() == 1


def test_ten_tries_an_hour_per_account_is_the_hard_throttle(lot, owner, settings):
    settings.OPERATOR_INVITE_FAIL_LIMIT = 100  # isolate the throttle from the wrong-code lock
    staff = make_user("DRIVER")

    codes = [accept(staff, "ABCDE-FGHIJ-KLMNO-PQRST-UVWXY-Z").status_code for _ in range(11)]

    assert codes[:10] == [400] * 10
    assert codes[10] == 429


def test_anonymous_cannot_accept(lot):
    assert APIClient().post(ACCEPT, {"code": "x"}, format="json").status_code == 401


def test_the_code_field_is_required(lot):
    assert client_for(make_user("DRIVER")).post(ACCEPT, {}, format="json").status_code == 400


# --- consequences -----------------------------------------------------------------------------


def test_the_new_operator_can_use_the_gate_and_loses_it_when_revoked(lot, owner):
    staff = make_user("DRIVER")
    accept(staff, invite(lot, owner)[1])
    api = client_for(User.objects.get(pk=staff.pk))  # the role is read from the database
    assert api.get(f"/api/v1/operator/parkings/{lot.id}/slots").status_code == 200

    assignment = OperatorAssignment.objects.get(operator=staff)
    operator_services.revoke_operator(lot=lot, assignment_id=assignment.pk, actor=owner)

    assert api.get(f"/api/v1/operator/parkings/{lot.id}/slots").status_code in (403, 404)
    staff.refresh_from_db()
    assert staff.role == User.Role.DRIVER


def test_invitation_constraints_in_the_database(lot, owner):
    from django.db import IntegrityError, transaction

    row = invite(lot, owner)[0]

    with pytest.raises(IntegrityError), transaction.atomic():
        OperatorInvite.objects.filter(pk=row.pk).update(used_at=timezone.now())  # no used_by
    with pytest.raises(IntegrityError), transaction.atomic():
        OperatorInvite.objects.filter(pk=row.pk).update(
            used_at=timezone.now(), used_by=owner, revoked_at=timezone.now()
        )
