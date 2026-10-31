"""WebSocket authentication and the per-user notification stream.

Messages carry IDs and summaries only; clients fetch details over the authorized REST API.
"""

from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.conf import settings
from django.urls import path

from .services import authenticate_token


@database_sync_to_async
def _session_for(token: str):
    session = authenticate_token(token)
    if session is None or session.restricted_reason:
        return None
    return session


class TokenAuthMiddleware:
    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        token = None
        for name, value in scope.get("headers", []):
            if name == b"cookie":
                for part in value.decode().split(";"):
                    key, _, val = part.strip().partition("=")
                    if key == settings.ERP["SESSION_COOKIE_NAME"]:
                        token = val
        if token is None:
            token = (parse_qs(scope.get("query_string", b"").decode()).get("token") or [None])[0]
        scope["erp_session"] = await _session_for(token) if token else None
        return await self.inner(scope, receive, send)


class UserStreamConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        session = self.scope.get("erp_session")
        if session is None:
            await self.close(code=4401)
            return
        self.group = f"user.{session.user_id}"
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept()

    async def disconnect(self, code):
        if hasattr(self, "group"):
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def receive_json(self, content, **kwargs):
        if content.get("type") == "ping":
            await self.send_json({"type": "pong"})

    async def stream_message(self, event):
        await self.send_json(event["message"])


websocket_urlpatterns = [path("ws/v1/stream/", UserStreamConsumer.as_asgi())]
