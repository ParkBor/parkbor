"""Data checks run by migrations before they add an EXCLUDE constraint.

A constraint that finds existing violations makes ``ALTER TABLE`` fail half way with an opaque
error. These checks fail first, with the ids of the offending bookings, so an operator can fix
the data (cancel one of each pair) and re-run the migration.
"""

LIVE = ("PENDING_PAYMENT", "CONFIRMED", "ACTIVE", "OVERSTAY")
REPORT_LIMIT = 20


def assert_no_vehicle_overlaps(booking_model, *, key: str) -> None:
    """Raise RuntimeError if two live bookings share `key` (``vehicle`` or ``vehicle_plate``)
    and overlap in time (half-open periods: touching ones are fine)."""
    rows = (
        booking_model.objects.filter(status__in=LIVE)
        .order_by(key, "starts_at", "ends_at")
        .values_list("pk", key, "starts_at", "ends_at")
    )
    clashes = []
    current_key, latest_pk, latest_end = object(), None, None
    for pk, value, starts_at, ends_at in rows.iterator():
        if value == current_key and latest_end is not None and starts_at < latest_end:
            clashes.append((latest_pk, pk))
        if value != current_key or latest_end is None or ends_at > latest_end:
            latest_pk, latest_end = pk, ends_at
        current_key = value
    if clashes:
        shown = "; ".join(f"{a} <-> {b}" for a, b in clashes[:REPORT_LIMIT])
        raise RuntimeError(
            f"{len(clashes)} pair(s) of live bookings overlap for the same {key}; cancel one of "
            f"each pair and re-run the migration: {shown}"
        )
