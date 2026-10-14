"""Tiny in-memory stores: callback payloads and a per-user cooldown."""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass


@dataclass(slots=True)
class _Entry:
    value: str
    expires_at: float


class LinkStore:
    """Maps a short token to a URL, because callback_data is capped at 64 bytes."""

    def __init__(self, ttl: int = 3600, max_size: int = 5000) -> None:
        self._ttl = ttl
        self._max_size = max_size
        self._data: dict[str, _Entry] = {}

    def put(self, value: str) -> str:
        self._prune()
        token = secrets.token_urlsafe(6)
        self._data[token] = _Entry(value=value, expires_at=time.monotonic() + self._ttl)
        return token

    def get(self, token: str) -> str | None:
        entry = self._data.get(token)
        if entry is None:
            return None
        if entry.expires_at < time.monotonic():
            self._data.pop(token, None)
            return None
        return entry.value

    def _prune(self) -> None:
        now = time.monotonic()
        expired = [key for key, entry in self._data.items() if entry.expires_at < now]
        for key in expired:
            self._data.pop(key, None)
        if len(self._data) > self._max_size:
            for key in list(self._data)[: len(self._data) - self._max_size]:
                self._data.pop(key, None)


class Cooldown:
    """Rejects a second job while the previous one is still running."""

    def __init__(self) -> None:
        self._busy: set[int] = set()

    def acquire(self, user_id: int) -> bool:
        if user_id in self._busy:
            return False
        self._busy.add(user_id)
        return True

    def release(self, user_id: int) -> None:
        self._busy.discard(user_id)
