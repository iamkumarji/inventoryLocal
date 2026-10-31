"""UUIDv7 generation (RFC 9562).

Time-ordered UUIDs keep B-tree inserts index-local, which matters for large
append-only tables such as the stock ledger and journal lines.
"""

import os
import time
import uuid

_RAND_B_MASK = (1 << 62) - 1


def uuid7() -> uuid.UUID:
    unix_ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big")  # 80 random bits
    value = (unix_ms & 0xFFFF_FFFF_FFFF) << 80
    value |= 0x7 << 76  # version
    value |= ((rand >> 68) & 0xFFF) << 64  # rand_a (12 bits)
    value |= 0b10 << 62  # RFC 4122 variant
    value |= rand & _RAND_B_MASK  # rand_b (62 bits)
    return uuid.UUID(int=value)


def uuid7_timestamp_ms(value: uuid.UUID) -> int:
    return value.int >> 80
