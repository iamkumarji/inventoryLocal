from rest_framework.pagination import CursorPagination, PageNumberPagination


class StandardPagination(PageNumberPagination):
    page_size = 50
    page_size_query_param = "page_size"
    max_page_size = 200


class LedgerCursorPagination(CursorPagination):
    """Stable cursor pagination for append-only streams (ledgers, audit, activity).

    UUIDv7 primary keys are time-ordered, so ordering by id is chronological.
    """

    page_size = 100
    page_size_query_param = "page_size"
    max_page_size = 500
    ordering = "-id"
