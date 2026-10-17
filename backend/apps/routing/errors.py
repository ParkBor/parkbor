"""API errors of GET /routes (rendered as {"detail", "code"})."""

from rest_framework import status

from apps.core.exceptions import ApiError, ServiceUnavailableError


class RouteNotFoundError(ApiError):
    status_code = status.HTTP_404_NOT_FOUND
    default_detail = "No drivable route between these points."
    default_code = "route_not_found"


class RoutingUnavailable(ServiceUnavailableError):  # noqa: N818 - public API error name
    default_detail = "Routing is temporarily unavailable. Try again shortly."
    default_code = "routing_unavailable"


class RouteTooFarError(ApiError):
    """Start or destination outside the service area, or the points are too far apart."""

    status_code = status.HTTP_400_BAD_REQUEST
    default_detail = "Route is outside the service area or too long."
    default_code = "route_too_far"
