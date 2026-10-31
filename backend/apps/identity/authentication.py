"""Session-token authentication for DRF.

* Web: HttpOnly `erp_session` cookie + double-submit CSRF (`X-CSRF-Token` header
  must equal the `erp_csrf` cookie) on unsafe methods.
* Mobile/API: `Authorization: Bearer <token>`.
"""

import hmac

from django.conf import settings
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied

from apps.core.context import user_id_var

from .services import authenticate_token

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


class SessionTokenAuthentication(BaseAuthentication):
    keyword = "Bearer"

    def authenticate(self, request):
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if header:
            parts = header.split()
            if len(parts) != 2 or parts[0] != self.keyword:
                raise AuthenticationFailed("Invalid authorization header.")
            return self._authenticate(parts[1])

        token = request.COOKIES.get(settings.ERP["SESSION_COOKIE_NAME"])
        if not token:
            return None
        result = self._authenticate(token)
        if request.method not in SAFE_METHODS:
            self._enforce_csrf(request)
        return result

    def _authenticate(self, token: str):
        session = authenticate_token(token)
        if session is None:
            raise AuthenticationFailed("Session is invalid or has expired.")
        user_id_var.set(str(session.user_id))
        return session.user, session

    def _enforce_csrf(self, request) -> None:
        cookie = request.COOKIES.get(settings.ERP["CSRF_COOKIE_NAME"], "")
        header = request.META.get(settings.ERP["CSRF_HEADER_NAME"], "")
        if not cookie or not header or not hmac.compare_digest(cookie, header):
            raise PermissionDenied("CSRF verification failed.")

    def authenticate_header(self, request) -> str:
        return f'{self.keyword} realm="api"'
