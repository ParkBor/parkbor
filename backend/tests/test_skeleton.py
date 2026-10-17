import uuid

import pytest
from django.conf import settings
from django.test import Client
from django.urls import NoReverseMatch, reverse

from apps.core.models import BaseModel


def test_api_docs_returns_200():
    assert Client().get("/api/docs/").status_code == 200


def test_api_schema_returns_200():
    assert Client().get("/api/schema/").status_code == 200


def test_django_admin_not_installed():
    assert "django.contrib.admin" not in settings.INSTALLED_APPS


def test_admin_path_is_404():
    assert Client().get("/admin/").status_code == 404


def test_admin_url_name_not_registered():
    with pytest.raises(NoReverseMatch):
        reverse("admin:index")


def test_base_model_is_abstract_with_uuid_and_created_at():
    assert BaseModel._meta.abstract is True
    names = {f.name for f in BaseModel._meta.get_fields()}
    assert {"id", "created_at"} <= names
    assert BaseModel._meta.get_field("id").default is uuid.uuid4


def test_timezone_is_tashkent_and_use_tz_enabled():
    assert settings.TIME_ZONE == "Asia/Tashkent"
    assert settings.USE_TZ is True


def test_docs_and_schema_are_public_even_with_closed_drf_defaults():
    from rest_framework.permissions import AllowAny

    from config.urls import urlpatterns

    named = {p.name: p.callback.cls for p in urlpatterns if getattr(p, "name", None)}
    for name in ("schema", "docs"):
        assert named[name].permission_classes == [AllowAny]
