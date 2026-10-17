from rest_framework.routers import DefaultRouter

from .views import ParkingLotViewSet, SlotViewSet, TariffViewSet, ZoneViewSet

router = DefaultRouter(trailing_slash=False)
router.register("parkings", ParkingLotViewSet, basename="admin-parking")
router.register("zones", ZoneViewSet, basename="admin-zone")
router.register("slots", SlotViewSet, basename="admin-slot")
router.register("tariffs", TariffViewSet, basename="admin-tariff")

urlpatterns = router.urls
