import re

from .context import new_request_id, request_id_var, user_id_var

_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9\-_.]{8,64}$")


class RequestContextMiddleware:
    """Assigns a request ID (or accepts a well-formed one from the proxy) and echoes it."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        incoming = request.headers.get("X-Request-ID", "")
        request_id = incoming if _SAFE_REQUEST_ID.match(incoming) else new_request_id()
        request.request_id = request_id
        token = request_id_var.set(request_id)
        user_token = user_id_var.set(None)
        try:
            response = self.get_response(request)
        finally:
            request_id_var.reset(token)
            user_id_var.reset(user_token)
        response["X-Request-ID"] = request_id
        return response
