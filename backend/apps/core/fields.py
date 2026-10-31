"""Precise numeric field types. Floats are never used for money or quantity."""

from django.db import models


class MoneyField(models.DecimalField):
    """NUMERIC(20,4): document and ledger amounts."""

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("max_digits", 20)
        kwargs.setdefault("decimal_places", 4)
        super().__init__(*args, **kwargs)


class QuantityField(models.DecimalField):
    """NUMERIC(20,6): stock quantities in a declared unit of measure."""

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("max_digits", 20)
        kwargs.setdefault("decimal_places", 6)
        super().__init__(*args, **kwargs)


class RateField(models.DecimalField):
    """NUMERIC(20,6): unit prices, unit costs, conversion factors."""

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("max_digits", 20)
        kwargs.setdefault("decimal_places", 6)
        super().__init__(*args, **kwargs)


class PercentField(models.DecimalField):
    """NUMERIC(9,4): percentages such as tax and tolerance rates."""

    def __init__(self, *args, **kwargs):
        kwargs.setdefault("max_digits", 9)
        kwargs.setdefault("decimal_places", 4)
        super().__init__(*args, **kwargs)
