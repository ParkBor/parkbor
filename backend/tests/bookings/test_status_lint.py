"""Lint: ``Booking.status`` is written only by apps.bookings.{services,models,state}.

The model guard is the enforcement; this scan catches attempts at review time and proves the
scanner itself works (it must find the planted offenders in its own fixtures).
"""

import ast
from pathlib import Path

APPS = Path(__file__).resolve().parents[2] / "apps"
ALLOWED = {"services.py", "models.py", "state.py"}


def _mentions_booking(node) -> bool:
    return "booking" in ast.unparse(node).lower()


def offenders_in(source: str) -> list[int]:
    """Line numbers of statements that would change a booking's status outside the services."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Assign | ast.AugAssign):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if any(isinstance(t, ast.Attribute) and t.attr == "status" for t in targets) and any(
                _mentions_booking(t) for t in targets
            ):
                found.append(node.lineno)
        if not isinstance(node, ast.Call):
            continue
        name = (
            node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
        )
        if name == "setattr" and len(node.args) >= 2:
            if ast.unparse(node.args[1]) in ("'status'", '"status"') and _mentions_booking(
                node.args[0]
            ):
                found.append(node.lineno)
        if name == "update" and _mentions_booking(node.func):
            if any(k.arg == "status" or k.arg is None for k in node.keywords):  # status= or **{}
                found.append(node.lineno)
        if name == "bulk_update" and _mentions_booking(node.func):
            if "status" in ast.unparse(node.args[1:2]):
                found.append(node.lineno)
    return found


def test_the_scanner_catches_every_known_way_to_write_a_status():
    planted = """
booking.status = "CONFIRMED"
setattr(booking, "status", "CONFIRMED")
Booking.objects.filter(pk=1).update(status="CONFIRMED")
Booking.objects.filter(pk=1).update(**{"status": "CONFIRMED"})
Booking.objects.bulk_update([booking], ["status"])
"""
    assert len(offenders_in(planted)) == 5


def test_the_scanner_ignores_innocent_code():
    innocent = """
lot.status = "ACTIVE"
Booking.objects.filter(pk=1).update(amount=5)
Slot.objects.update(status="FREE")
"""
    assert offenders_in(innocent) == []


def test_no_module_outside_the_bookings_services_writes_booking_status():
    files = [p for p in APPS.rglob("*.py") if "migrations" not in p.parts]
    assert len(files) > 50  # the scan actually looked at the codebase
    offenders = []
    for path in files:
        if "bookings" in path.parts and path.name in ALLOWED:
            continue
        offenders += [f"{path.name}:{n}" for n in offenders_in(path.read_text(encoding="utf-8"))]
    assert not offenders, offenders
