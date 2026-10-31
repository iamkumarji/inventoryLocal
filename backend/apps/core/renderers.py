"""JSON rendering that never turns money into binary floats.

DRF's encoder renders `Decimal` as float, so report endpoints returning plain dicts would emit
5000.1 as 5000.0999... in some clients. Decimals are rendered as strings, matching serializer
DecimalFields (COERCE_DECIMAL_TO_STRING).
"""

from decimal import Decimal

from rest_framework.renderers import JSONRenderer
from rest_framework.utils.encoders import JSONEncoder


class DecimalSafeEncoder(JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return str(obj)
        return super().default(obj)


class ERPJSONRenderer(JSONRenderer):
    encoder_class = DecimalSafeEncoder
