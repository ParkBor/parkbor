from django.db import migrations

# PostgreSQL only: the database itself refuses what the model refuses. UPDATE is allowed only for
# the ON DELETE SET NULL of ``actor_id`` (Django emulates it with an UPDATE when an account is
# deleted); DELETE only inside the retention purge, which sets ``habi.audit_purge`` for its
# transaction (apps/audit/services.py).
FORWARD = """
CREATE FUNCTION audit_log_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF (to_jsonb(NEW) - 'actor_id') IS DISTINCT FROM (to_jsonb(OLD) - 'actor_id')
           OR NEW.actor_id IS NOT NULL THEN
            RAISE EXCEPTION 'audit_log is append-only';
        END IF;
        RETURN NEW;
    END IF;
    IF coalesce(current_setting('habi.audit_purge', true), '') <> 'on' THEN
        RAISE EXCEPTION 'audit_log rows are deleted only by the retention purge';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_append_only
    BEFORE UPDATE OR DELETE ON audit_auditlog
    FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
"""
BACKWARD = """
DROP TRIGGER IF EXISTS audit_log_append_only ON audit_auditlog;
DROP FUNCTION IF EXISTS audit_log_guard();
"""


def add_trigger(apps, schema_editor):
    if schema_editor.connection.vendor == "postgresql":
        schema_editor.execute(FORWARD)


def drop_trigger(apps, schema_editor):
    if schema_editor.connection.vendor == "postgresql":
        schema_editor.execute(BACKWARD)


class Migration(migrations.Migration):
    dependencies = [("audit", "0001_initial")]

    operations = [migrations.RunPython(add_trigger, drop_trigger)]
