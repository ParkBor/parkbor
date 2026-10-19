"""Filter building blocks shared by the admin lists."""

import django_filters


class RangeFilterSet(django_filters.FilterSet):
    """``?from=`` / ``?to=`` on ``range_field`` (default ``created_at``): ISO 8601, ``from``
    INCLUSIVE, ``to`` EXCLUSIVE (the start of the next day). A value without a UTC offset is read
    in the project time zone (Asia/Tashkent) - the same everywhere, including the statistics."""

    range_field = "created_at"
    from_ = django_filters.IsoDateTimeFilter(method="filter_from")
    to_ = django_filters.IsoDateTimeFilter(method="filter_to")

    def __init__(self, data=None, *args, **kwargs):
        if data is not None:
            data = data.copy()
            for name in ("from", "to"):
                if name in data:
                    data[f"{name}_"] = data[name]
        super().__init__(data, *args, **kwargs)

    def filter_from(self, queryset, name, value):
        return queryset.filter(**{f"{self.range_field}__gte": value})

    def filter_to(self, queryset, name, value):
        return queryset.filter(**{f"{self.range_field}__lt": value})
