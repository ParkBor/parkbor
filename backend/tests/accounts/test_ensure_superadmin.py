import io

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.accounts.models import User

pytestmark = pytest.mark.django_db


def run(*ids: int) -> str:
    out = io.StringIO()
    args = [arg for telegram_id in ids for arg in ("--telegram-id", str(telegram_id))]
    call_command("ensure_superadmin", *args, stdout=out)
    return out.getvalue()


def test_creates_a_telegram_only_super_admin_without_a_usable_password():
    run(1705098070)
    admin = User.objects.get(telegram_id=1705098070)
    assert admin.role == User.Role.ADMIN
    assert admin.is_superuser and admin.is_active
    assert not admin.has_usable_password()


def test_handles_several_ids_in_one_run():
    run(1705098070, 5977250410)
    assert User.objects.filter(is_superuser=True).count() == 2


def test_promotes_an_existing_driver_and_keeps_the_profile():
    driver = User.objects.create_user(telegram_id=42, first_name="Ali")
    run(42)
    driver.refresh_from_db()
    assert driver.role == User.Role.ADMIN and driver.is_superuser
    assert driver.first_name == "Ali"


def test_keeps_an_existing_password():
    admin = User.objects.create_superuser(telegram_id=7, password="correct-horse-battery")
    run(7)
    admin.refresh_from_db()
    assert admin.check_password("correct-horse-battery")


def test_reactivates_a_blocked_account():
    blocked = User.objects.create_user(telegram_id=9, is_active=False)
    run(9)
    blocked.refresh_from_db()
    assert blocked.is_active


def test_is_idempotent():
    run(5)
    run(5)
    assert User.objects.filter(telegram_id=5).count() == 1


def test_reads_ids_from_the_environment_when_no_option_is_given(monkeypatch):
    monkeypatch.setenv("SUPERADMIN_TELEGRAM_IDS", "1705098070, 5977250410")
    call_command("ensure_superadmin", stdout=io.StringIO())
    assert set(User.objects.filter(is_superuser=True).values_list("telegram_id", flat=True)) == {
        1705098070,
        5977250410,
    }


def test_explicit_option_wins_over_the_environment(monkeypatch):
    monkeypatch.setenv("SUPERADMIN_TELEGRAM_IDS", "111")
    run(222)
    assert list(User.objects.values_list("telegram_id", flat=True)) == [222]


def test_nothing_configured_is_a_harmless_no_op(monkeypatch):
    monkeypatch.delenv("SUPERADMIN_TELEGRAM_IDS", raising=False)
    out = io.StringIO()
    call_command("ensure_superadmin", stdout=out)
    assert not User.objects.exists()
    assert "nothing to do" in out.getvalue()


def test_garbage_in_the_environment_fails_loudly(monkeypatch):
    monkeypatch.setenv("SUPERADMIN_TELEGRAM_IDS", "12,abc")
    with pytest.raises(CommandError):
        call_command("ensure_superadmin")
    assert not User.objects.exists()


def test_rejects_a_non_positive_id():
    with pytest.raises(CommandError):
        call_command("ensure_superadmin", "--telegram-id", "0")
    assert not User.objects.exists()
