from rest_framework import status
from rest_framework.exceptions import APIException, ErrorDetail


class ApiError(APIException):
    """API error rendered as {"detail": <message>, "code": <machine code>}."""

    def __init__(self, detail: str | None = None, code: str | None = None):
        code = code or self.default_code
        super().__init__(detail=detail or self.default_detail, code=code)
        # Rendered as {"detail": ..., "code": ...}; both carry the machine code so that
        # get_codes()/get_full_details() stay truthful.
        self.detail = {
            "detail": ErrorDetail(str(self.detail), code),
            "code": ErrorDetail(code, code),
        }


class ServiceUnavailableError(ApiError):
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_detail = "Service temporarily unavailable. Try again shortly."
    default_code = "service_unavailable"


class InvalidTransition(ApiError):  # noqa: N818 - name used by apps.parking.services
    """Illegal state-machine transition (restored: the parking agent imports it from here)."""

    status_code = status.HTTP_409_CONFLICT
    default_detail = "Invalid state transition."
    default_code = "invalid_transition"


class LoginExpiredError(ApiError):
    status_code = status.HTTP_410_GONE
    default_detail = "Login session expired or cancelled."
    default_code = "login_expired"


class LoginNotConfirmedError(ApiError):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "Login has not been confirmed in the Telegram bot yet."
    default_code = "login_not_confirmed"


class InvalidCodeError(ApiError):
    status_code = status.HTTP_400_BAD_REQUEST
    default_detail = "Invalid code."
    default_code = "invalid_code"


class InvalidWidgetError(ApiError):
    status_code = status.HTTP_400_BAD_REQUEST
    default_detail = "Invalid or outdated Telegram widget data."
    default_code = "invalid_widget"


class RoleNotAllowedError(ApiError):
    status_code = status.HTTP_403_FORBIDDEN
    default_detail = "This account may not use the admin panel."
    default_code = "role_not_allowed"


class AccountDisabledError(ApiError):
    status_code = status.HTTP_403_FORBIDDEN
    default_detail = "Account is disabled."
    default_code = "account_disabled"


class PhoneTakenError(ApiError):
    status_code = status.HTTP_409_CONFLICT
    default_detail = "This phone number is linked to another account."
    default_code = "phone_taken"


class InvalidRefreshTokenError(ApiError):
    status_code = status.HTTP_400_BAD_REQUEST
    default_detail = "Invalid refresh token."
    default_code = "invalid_token"


class InvalidWebhookSecretError(ApiError):
    status_code = status.HTTP_403_FORBIDDEN
    default_detail = "Forbidden."
    default_code = "invalid_webhook_secret"


class DomainValidationError(ApiError):
    status_code = status.HTTP_400_BAD_REQUEST
    default_detail = "Invalid input."
    default_code = "validation_error"


class DomainPermissionDenied(ApiError):
    status_code = status.HTTP_403_FORBIDDEN
    default_detail = "You do not have permission to perform this action."
    default_code = "permission_denied"


class Conflict(ApiError):
    """State/uniqueness conflict, e.g. duplicate code or an object still referenced (409)."""

    status_code = status.HTTP_409_CONFLICT
    default_detail = "The request conflicts with the current state."
    default_code = "conflict"


class NotFoundError(ApiError):
    status_code = status.HTTP_404_NOT_FOUND
    default_detail = "Not found."
    default_code = "not_found"


class UserNotFoundError(ApiError):
    """Token is valid but its user no longer exists: the client must end the session."""

    status_code = status.HTTP_401_UNAUTHORIZED
    default_detail = "User not found."
    default_code = "user_not_found"


class UnprocessableError(ApiError):
    """Well-formed request that breaks a business rule (422), e.g. booking period too short.

    Subclasses/instances carry a specific machine ``code`` the client can switch on.
    """

    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    default_detail = "The request cannot be processed."
    default_code = "unprocessable"
