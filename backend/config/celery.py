import os

from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.prod")

app = Celery("habi")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()

# Celery Beat (ARCHITECTURE 16). Every task is idempotent and batch-limited, so an overlapping or
# repeated run is harmless. `expires`: a run queued while the workers were down is dropped, so a
# backlog of identical sweeps never piles up behind a recovered worker.
CELERY_BEAT_SCHEDULE = {
    "bookings-mark-no-shows": {
        "task": "bookings.mark_no_shows",
        "schedule": 60.0,
        "options": {"expires": 55},
    },
    "bookings-detect-overstays": {
        "task": "bookings.detect_overstays",
        "schedule": 60.0,
        "options": {"expires": 55},
    },
    "bookings-expire-overdue-holds": {
        "task": "bookings.expire_overdue_holds",
        "schedule": 60.0,
        "options": {"expires": 55},
    },
    "parking-reconcile-free-slots": {
        "task": "parking.reconcile_free_slots",
        "schedule": 300.0,
        "options": {"expires": 290},
    },
    # expires: a run queued while the workers were down is dropped, not piled up
    "payments-retry-failed-webhooks": {
        "task": "payments.retry_failed_webhooks",
        "schedule": 300.0,
        "options": {"expires": 300},
    },
    "payments-purge-webhook-events": {
        "task": "payments.purge_webhook_events",
        "schedule": 86400.0,
        "options": {"expires": 3600},
    },
    # Notifications (Step 10a). expires: a run queued while the workers were down is dropped.
    "notifications-send-reminders": {
        "task": "notifications.send_reminders",
        "schedule": 60.0,
        "options": {"expires": 55},
    },
    "notifications-resend-pending": {
        "task": "notifications.resend_pending",
        "schedule": 300.0,
        "options": {"expires": 300},
    },
    "notifications-check-push-receipts": {
        "task": "notifications.check_push_receipts",
        "schedule": 900.0,
        "options": {"expires": 900},
    },
    "notifications-prune-push-tokens": {
        "task": "notifications.prune_push_tokens",
        "schedule": 86400.0,
        "options": {"expires": 3600},
    },
    "notifications-purge-notification-log": {
        "task": "notifications.purge_notification_log",
        "schedule": 86400.0,
        "options": {"expires": 3600},
    },
    # append-only log: the only thing that ever deletes from it (apps/audit/services.py)
    "audit-purge-audit-log": {
        "task": "audit.purge_audit_log",
        "schedule": 86400.0,
        "options": {"expires": 3600},
    },
}
app.conf.beat_schedule = CELERY_BEAT_SCHEDULE
