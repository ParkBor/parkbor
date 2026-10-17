"""Shapes of the provider callbacks. Used only to document the OpenAPI schema: the adapters
parse the raw body themselves (Payme sends ``text/json``; Click sends a signed form)."""

from rest_framework import serializers


class PaymeRpcRequestSerializer(serializers.Serializer):
    method = serializers.CharField(
        help_text="CheckPerformTransaction | CreateTransaction | PerformTransaction | "
        "CancelTransaction | CheckTransaction | GetStatement"
    )
    params = serializers.DictField(help_text="Method parameters (amounts in tiyin).")
    id = serializers.IntegerField(help_text="JSON-RPC request id, echoed in the answer.")


class PaymeRpcResponseSerializer(serializers.Serializer):
    result = serializers.DictField(required=False, help_text="Present on success.")
    error = serializers.DictField(
        required=False, help_text="Present on failure: {code, message{ru,uz,en}, data?}."
    )
    id = serializers.IntegerField(allow_null=True)


class ClickWebhookRequestSerializer(serializers.Serializer):
    click_trans_id = serializers.CharField()
    service_id = serializers.CharField()
    click_paydoc_id = serializers.CharField(required=False)
    merchant_trans_id = serializers.CharField(help_text="The booking id.")
    merchant_prepare_id = serializers.CharField(required=False, help_text="Complete only.")
    amount = serializers.CharField(help_text="So'm, plain decimal text (N or N.NN).")
    action = serializers.ChoiceField(choices=["0", "1"], help_text="0 = Prepare, 1 = Complete.")
    error = serializers.CharField(required=False)
    error_note = serializers.CharField(required=False)
    sign_time = serializers.CharField(help_text="YYYY-MM-DD HH:mm:ss")
    sign_string = serializers.CharField(help_text="md5 signature (see ARCHITECTURE 8.4).")


class ClickWebhookResponseSerializer(serializers.Serializer):
    click_trans_id = serializers.CharField(required=False)
    merchant_trans_id = serializers.CharField(required=False)
    merchant_prepare_id = serializers.CharField(required=False, help_text="Prepare only.")
    merchant_confirm_id = serializers.CharField(required=False, help_text="Complete only.")
    error = serializers.IntegerField(help_text="0 = success, -1 .. -9 = Click protocol errors.")
    error_note = serializers.CharField()
