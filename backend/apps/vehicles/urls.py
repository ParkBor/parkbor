from rest_framework.routers import SimpleRouter

from .views import VehicleViewSet

router = SimpleRouter(trailing_slash=False)
router.register("vehicles", VehicleViewSet, basename="vehicle")

urlpatterns = router.urls
