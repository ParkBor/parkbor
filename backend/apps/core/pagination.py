from rest_framework.pagination import PageNumberPagination


class StandardPagination(PageNumberPagination):
    """Server-side paging for admin tables: ?page=&page_size= (max 100)."""

    page_size = 20
    page_size_query_param = "page_size"
    max_page_size = 100
