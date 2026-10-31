import ipaddress

from django.conf import settings


def client_ip(request) -> str | None:
    """Client IP honouring exactly ERP.TRUSTED_PROXY_COUNT proxies (never trust arbitrary X-Forwarded-For)."""
    meta = getattr(request, "META", {})
    remote = meta.get("REMOTE_ADDR")
    proxies = settings.ERP["TRUSTED_PROXY_COUNT"]
    forwarded = meta.get("HTTP_X_FORWARDED_FOR", "")
    if proxies > 0 and forwarded:
        chain = [part.strip() for part in forwarded.split(",") if part.strip()]
        if len(chain) >= proxies:
            candidate = chain[-proxies]
            try:
                ipaddress.ip_address(candidate)
                return candidate
            except ValueError:
                pass
    return remote
