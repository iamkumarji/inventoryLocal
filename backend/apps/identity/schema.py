from drf_spectacular.extensions import OpenApiAuthenticationExtension


class SessionTokenScheme(OpenApiAuthenticationExtension):
    target_class = "apps.identity.authentication.SessionTokenAuthentication"
    name = ["cookieSession", "bearerSession"]

    def get_security_definition(self, auto_schema):
        return [
            {
                "type": "apiKey",
                "in": "cookie",
                "name": "erp_session",
                "description": "Web: HttpOnly session cookie plus X-CSRF-Token header on unsafe methods.",
            },
            {"type": "http", "scheme": "bearer", "description": "Mobile/API: opaque session token."},
        ]
