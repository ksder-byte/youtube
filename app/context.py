"""Shared runtime objects passed into handlers via aiogram workflow data."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from .cobalt import CobaltClient
from .config import Settings
from .storage import Cooldown, LinkStore


@dataclass(slots=True)
class Context:
    settings: Settings
    cobalt: CobaltClient
    links: LinkStore = field(default_factory=LinkStore)
    cooldown: Cooldown = field(default_factory=Cooldown)
    slots: asyncio.Semaphore = field(init=False)

    def __post_init__(self) -> None:
        self.slots = asyncio.Semaphore(self.settings.max_concurrent_downloads)
