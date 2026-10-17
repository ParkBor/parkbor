"""Domain errors of the payment flow. They carry no data from the request (no amounts, ids,
signatures): provider adapters translate them to the provider's own protocol error codes."""


class PaymentError(Exception):
    """Base of every expected, protocol-mappable payment failure."""

    code = "payment_error"


class OrderNotFound(PaymentError):  # noqa: N818 - reads as a protocol outcome, not an "error"
    """No booking for the order id the provider sent (also: not a valid UUID)."""

    code = "order_not_found"


class OrderNotPayable(PaymentError):  # noqa: N818
    """The booking exists but cannot take a payment now: cancelled, expired, hold over."""

    code = "order_not_payable"


class OrderAlreadyPaid(PaymentError):  # noqa: N818
    """The booking is already paid (CONFIRMED or further along)."""

    code = "order_already_paid"


class AmountMismatch(PaymentError):  # noqa: N818
    """The provider's amount differs from the booking amount."""

    code = "amount_mismatch"


class ConflictingTransaction(PaymentError):  # noqa: N818
    """Another open transaction already exists for this booking, or the provider transaction id
    is already used for a different booking."""

    code = "conflicting_transaction"


class TransactionNotFound(PaymentError):  # noqa: N818
    code = "transaction_not_found"


class TransactionStateError(PaymentError):  # noqa: N818
    """The operation is not allowed in the transaction's current state (Payme -31008)."""

    code = "transaction_state"


class OrderCompleted(PaymentError):  # noqa: N818
    """A performed transaction cannot be cancelled: the service was already provided (-31007)."""

    code = "order_completed"
