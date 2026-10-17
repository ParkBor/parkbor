from rest_framework import serializers


class WsTicketSerializer(serializers.Serializer):
    ticket = serializers.CharField(
        help_text="One-time credential for wss://<host>/ws/availability/"
    )
    expires_in = serializers.IntegerField(help_text="Seconds until the ticket expires (30).")
