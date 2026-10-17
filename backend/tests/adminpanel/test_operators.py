"""Owner/admin API for staff: invitation codes and the operator list (ARCHITECTURE 2, 6.3, 9.3)."""

import hashlib
import logging
from datetime import timedelta

import pytest
from django.utils import timezone
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.audit.models import AuditLog
from apps.operators import services as operator_services
from apps.parking.models import LotStatus, OperatorAssignment, OperatorInvite
from tests.helpers import client_for, make_lot, make_user

pytestmark = pytest.mark.django_db


@pytest.fixture(autouse=True)
def _audit_records_reach_caplog(monkeypatch):
    monkeypatch.setattr(logging.getLogger("habi.audit"), "propagate", True)


@pytest.fixture
def owner():
    return make_user("OWNER")


@pytest.fixture
def lot(owner):
    return make_lot(owner, "Mine", status=LotStatus.ACTIVE)


def invites_url(lot, invite=None):
    base = f"/api/v1/admin/parkings/{lot.id}/operator-invites"
    return base if invite is None else f"{base}/{invite}"


def operators_url(lot, assignment=None):
    base = f"/api/v1/admin/parkings/{lot.id}/operators"
    return base if assignment is None else f"{base}/{assignment}"


def create(client, lot, **body):
    return client.post(invites_url(lot), body, format="json")


def join(lot, owner, **user_extra):
    """A staff member who accepted an invitation; returns (user, assignment_id)."""
    staff = make_user("DRIVER", **user_extra)
    _invite, code = operator_services.create_invite(lot=lot, actor=owner)
    operator_services.accept_invite(user=staff, code=code)
    return staff, OperatorAssignment.objects.get(operator=staff, revoked_at__isnull=True).pk


# --- creating invitations ----------------------------------------------------------------------


def test_owner_creates_an_invitation_and_gets_the_code_once(owner, lot):
    response = create(client_for(owner), lot)

    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"invite_id", "code", "expires_at"}
    plain = body["code"].replace("-", "")
    assert len(plain) == 26 and plain.isalnum() and plain == plain.upper()  # 128 bit, base32
    assert response["Cache-Control"] == "no-store"
    invite = OperatorInvite.objects.get(pk=body["invite_id"])
    assert invite.parking_lot_id == lot.id and invite.created_by_id == owner.id
    assert invite.token_hash == hashlib.sha256(plain.encode()).hexdigest()
    assert plain not in invite.token_hash  # only the hash is stored


def test_default_life_is_72_hours_and_can_be_shortened(owner, lot):
    default = create(client_for(owner), lot).json()
    short = create(client_for(owner), lot, expires_in_hours=2).json()

    now = timezone.now()
    first = OperatorInvite.objects.get(pk=default["invite_id"]).expires_at
    second = OperatorInvite.objects.get(pk=short["invite_id"]).expires_at
    assert timedelta(hours=71) < first - now <= timedelta(hours=72)
    assert timedelta(hours=1) < second - now <= timedelta(hours=2)
    assert create(client_for(owner), lot, expires_in_hours=0).status_code == 400
    assert create(client_for(owner), lot, expires_in_hours=100000).status_code == 400


def test_the_code_is_in_no_database_column(owner, lot):
    code = create(client_for(owner), lot).json()["code"].replace("-", "")

    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute("SELECT * FROM parking_operatorinvite")
        values = " ".join(str(v) for row in cursor.fetchall() for v in row)
    assert code not in values


def test_open_invites_per_lot_are_limited(owner, lot, settings):
    settings.OPERATOR_INVITE_MAX_OPEN = 2
    client = client_for(owner)
    create(client, lot)
    create(client, lot)

    third = create(client, lot)

    assert (third.status_code, third.json()["code"]) == (409, "invite_limit_reached")


def test_creation_is_audited_without_the_code(
    owner, lot, caplog, django_capture_on_commit_callbacks
):
    with (
        caplog.at_level(logging.INFO, logger="habi.audit"),
        django_capture_on_commit_callbacks(execute=True),
    ):
        body = create(client_for(owner), lot).json()

    row = AuditLog.objects.get(action="operator.invite_create")
    assert (row.actor_id, row.target_id) == (owner.id, body["invite_id"])
    everything = str(row.meta) + " ".join(str(r.__dict__) for r in caplog.records)
    assert body["code"].replace("-", "") not in everything


# --- who may call ------------------------------------------------------------------------------


def test_anonymous_driver_and_operator_cannot_manage_staff(lot):
    assert APIClient().get(invites_url(lot)).status_code == 401
    assert create(client_for(make_user("DRIVER")), lot).status_code == 403
    assert create(client_for(make_user("OPERATOR")), lot).status_code == 403
    assert client_for(make_user("OPERATOR")).get(operators_url(lot)).status_code == 403


def test_owner_cannot_manage_staff_of_a_foreign_lot(owner):
    foreign = make_lot(make_user("OWNER"), "Foreign")
    invite, _code = operator_services.create_invite(lot=foreign, actor=foreign.owner)
    client = client_for(owner)

    assert create(client, foreign).status_code == 404
    assert client.get(invites_url(foreign)).status_code == 404
    assert client.delete(invites_url(foreign, invite.pk)).status_code == 404
    assert client.get(operators_url(foreign)).status_code == 404
    assert OperatorInvite.objects.get(pk=invite.pk).revoked_at is None


def test_admin_manages_any_lot(lot):
    admin = make_user("ADMIN")

    assert create(client_for(admin), lot).status_code == 201
    assert client_for(admin).get(invites_url(lot)).status_code == 200


def test_there_is_no_lookup_by_phone_or_username_any_more(owner, lot):
    victim = make_user("DRIVER", phone="+998901234567", telegram_username="ali")
    client = client_for(owner)

    for body in ({"phone": victim.phone}, {"telegram_username": "ali"}):
        assert client.post(operators_url(lot), body, format="json").status_code == 405

    victim.refresh_from_db()
    assert victim.role == User.Role.DRIVER
    assert not OperatorAssignment.objects.exists()


# --- listing and revoking invitations ----------------------------------------------------------


def test_list_shows_open_invitations_without_codes(owner, lot):
    open_one = operator_services.create_invite(lot=lot, actor=owner)[0]
    revoked = operator_services.create_invite(lot=lot, actor=owner)[0]
    operator_services.revoke_invite(lot=lot, invite_id=revoked.pk, actor=owner)
    expired = operator_services.create_invite(
        lot=lot, actor=owner, now=timezone.now() - timedelta(days=10)
    )[0]
    used_code = operator_services.create_invite(lot=lot, actor=owner)[1]
    operator_services.accept_invite(user=make_user("DRIVER"), code=used_code)
    other_lot = make_lot(owner, "Other")
    operator_services.create_invite(lot=other_lot, actor=owner)

    response = client_for(owner).get(invites_url(lot))

    assert response.status_code == 200
    rows = response.json()["results"]
    assert [row["id"] for row in rows] == [str(open_one.pk)]
    assert set(rows[0]) == {"id", "created_at", "expires_at"}
    assert str(expired.pk) not in response.content.decode()


def test_revoking_an_invitation_kills_its_code_and_is_idempotent(owner, lot):
    created = create(client_for(owner), lot).json()
    client = client_for(owner)

    assert client.delete(invites_url(lot, created["invite_id"])).status_code == 204
    assert client.delete(invites_url(lot, created["invite_id"])).status_code == 204

    with pytest.raises(operator_services.InviteInvalid):
        operator_services.accept_invite(user=make_user("DRIVER"), code=created["code"])
    assert client.get(invites_url(lot)).json()["count"] == 0


def test_revoking_a_used_invitation_changes_nothing(owner, lot):
    invite, code = operator_services.create_invite(lot=lot, actor=owner)
    staff = make_user("DRIVER")
    operator_services.accept_invite(user=staff, code=code)

    assert client_for(owner).delete(invites_url(lot, invite.pk)).status_code == 204

    invite.refresh_from_db()
    assert invite.revoked_at is None and invite.used_by_id == staff.id


def test_unknown_or_malformed_invitation_ids_are_404(owner, lot):
    client = client_for(owner)

    assert (
        client.delete(invites_url(lot, "11111111-1111-1111-1111-111111111111")).status_code == 404
    )
    assert client.delete(invites_url(lot, "a" * 36)).status_code == 404


# --- the operator list -------------------------------------------------------------------------


def test_owner_sees_ids_and_a_masked_name_only(owner, lot):
    staff, assignment = join(
        lot,
        owner,
        first_name="Aziza",
        last_name="Karimova",
        phone="+998901234567",
        telegram_username="aziza_k",
    )

    response = client_for(owner).get(operators_url(lot))

    assert response.status_code == 200
    row = response.json()["results"][0]
    assert set(row) == {"id", "assignment_id", "display_name", "created_at"}
    assert (row["id"], row["assignment_id"]) == (str(staff.id), str(assignment))
    assert row["display_name"] == "Aziza K."
    raw = response.content.decode()
    for secret in ("998901234567", "aziza_k", "Karimova"):
        assert secret not in raw


def test_admin_gets_no_names_at_all(owner, lot):
    join(lot, owner, first_name="Aziza", last_name="Karimova")

    response = client_for(make_user("ADMIN")).get(operators_url(lot))

    assert response.json()["results"][0]["display_name"] is None
    assert "Aziza" not in response.content.decode()


# --- revoking an operator ----------------------------------------------------------------------


def test_revoking_the_last_assignment_returns_the_user_to_driver(owner, lot):
    staff, assignment = join(lot, owner)
    client = client_for(owner)

    response = client.delete(operators_url(lot, assignment))

    assert response.status_code == 204
    staff.refresh_from_db()
    assert staff.role == User.Role.DRIVER
    row = OperatorAssignment.objects.get()
    assert row.revoked_at is not None and row.revoked_by_id == owner.id
    assert client.get(operators_url(lot)).json()["count"] == 0
    assert AuditLog.objects.filter(action="operator.revoke").count() == 1


def test_revoking_keeps_the_operator_role_while_another_lot_remains(owner, lot):
    other = make_lot(owner, "Second", status=LotStatus.ACTIVE)
    staff, first = join(lot, owner)
    _invite, code = operator_services.create_invite(lot=other, actor=owner)
    operator_services.accept_invite(user=staff, code=code)

    client_for(owner).delete(operators_url(lot, first))

    staff.refresh_from_db()
    assert staff.role == User.Role.OPERATOR


def test_revoking_twice_is_harmless(owner, lot):
    _staff, assignment = join(lot, owner)
    client = client_for(owner)

    assert client.delete(operators_url(lot, assignment)).status_code == 204
    assert client.delete(operators_url(lot, assignment)).status_code == 204


def test_unknown_foreign_or_malformed_assignment_is_404(owner, lot):
    other_owner = make_user("OWNER")
    other_lot = make_lot(other_owner, "Theirs", status=LotStatus.ACTIVE)
    _staff, theirs = join(other_lot, other_owner)
    client = client_for(owner)

    assert client.delete(operators_url(lot, theirs)).status_code == 404  # wrong lot in the URL
    assert (
        client.delete(operators_url(lot, "11111111-1111-1111-1111-111111111111")).status_code == 404
    )
    assert client.delete(operators_url(lot, "a" * 36)).status_code == 404
    assert OperatorAssignment.objects.get().revoked_at is None


def test_database_allows_only_one_active_assignment_per_pair(owner, lot):
    from django.db import IntegrityError, transaction

    staff, _assignment = join(lot, owner)

    with pytest.raises(IntegrityError), transaction.atomic():
        OperatorAssignment.objects.create(operator=staff, parking_lot=lot, created_by=owner)


def test_a_lot_with_staff_history_cannot_be_deleted_silently(owner, lot):
    from django.db.models.deletion import ProtectedError

    join(lot, owner)

    with pytest.raises(ProtectedError):
        lot.delete()
