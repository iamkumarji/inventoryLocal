"""WebSocket stream: authentication, user-scoped groups and live notification push."""

import pytest
from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator

from apps.identity import services as identity
from apps.notifications import services
from config.asgi import application

pytestmark = pytest.mark.django_db(transaction=True)


def _session(user, restricted=""):
    _, token = identity.create_session(user, identity.ClientInfo(), mfa_verified=True, restricted_reason=restricted)
    return token


def _communicator(token=None, origin=b"http://localhost"):
    headers = [(b"origin", origin)]
    if token:
        headers.append((b"cookie", f"erp_session={token}".encode()))
    return WebsocketCommunicator(application, "/ws/v1/stream/", headers=headers)


def test_authenticated_user_receives_own_notifications_only(make_user):
    alice, bob = make_user(), make_user()
    alice_token, bob_token = _session(alice), _session(bob)

    async def scenario():
        a, b = _communicator(alice_token), _communicator(bob_token)
        assert (await a.connect())[0] and (await b.connect())[0]
        await a.send_json_to({"type": "ping"})
        assert await a.receive_json_from() == {"type": "pong"}
        await database_sync_to_async(services.notify)([alice], category="system", title="Shift report ready")
        message = await a.receive_json_from(timeout=2)
        assert message["type"] == "notification.created" and message["title"] == "Shift report ready"
        assert message["unread_count"] == 1
        assert await b.receive_nothing(timeout=0.3)
        await a.disconnect()
        await b.disconnect()

    async_to_sync(scenario)()


@pytest.mark.parametrize("case", ["no_token", "bad_token", "restricted", "foreign_origin"])
def test_connection_rejected(case, make_user):
    user = make_user()
    token = {
        "no_token": None,
        "bad_token": "nope",
        "restricted": _session(user, "mfa_enrollment"),
        "foreign_origin": _session(user),
    }[case]
    origin = b"https://evil.example" if case == "foreign_origin" else b"http://localhost"

    async def scenario():
        communicator = _communicator(token, origin)
        connected, _ = await communicator.connect()
        assert not connected
        await communicator.disconnect()

    async_to_sync(scenario)()
