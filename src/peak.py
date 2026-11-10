"""Single peak-hour rule for the generator, the live API, and coverage.

Weekdays: 08:00–10:00 and 17:00–19:00.
Weekends: 16:00–19:00.
Hours are inclusive. A weekend morning is not peak.
"""

from __future__ import annotations


def is_peak(hour_of_day: int, is_weekend: bool = False) -> bool:
    hour = int(hour_of_day)
    if bool(is_weekend):
        return 16 <= hour <= 19
    return 8 <= hour <= 10 or 17 <= hour <= 19
