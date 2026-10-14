"""Inline keyboards and their callback payloads."""

from __future__ import annotations

from dataclasses import dataclass

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup

MODE_VIDEO = "v"
MODE_AUDIO = "a"

QUALITY_CHOICES = ("360", "480", "720", "1080", "1440", "2160")


@dataclass(slots=True)
class DownloadCallback:
    mode: str
    quality: str
    token: str

    def pack(self) -> str:
        return f"dl:{self.mode}:{self.quality}:{self.token}"

    @staticmethod
    def unpack(data: str) -> "DownloadCallback | None":
        parts = data.split(":", 3)
        if len(parts) != 4 or parts[0] != "dl":
            return None
        return DownloadCallback(mode=parts[1], quality=parts[2], token=parts[3])


def subscribe_kb(channel_url: str | None) -> InlineKeyboardMarkup:
    rows: list[list[InlineKeyboardButton]] = []
    if channel_url:
        rows.append([InlineKeyboardButton(text="📢 Подписаться", url=channel_url)])
    rows.append([InlineKeyboardButton(text="✅ Проверить подписку", callback_data="sub:check")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def actions_kb(token: str, quality: str) -> InlineKeyboardMarkup:
    label = "макс." if quality == "max" else f"{quality}p"
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text=f"🎬 Видео ({label})",
                    callback_data=DownloadCallback(MODE_VIDEO, quality, token).pack(),
                ),
                InlineKeyboardButton(
                    text="🎵 Аудио",
                    callback_data=DownloadCallback(MODE_AUDIO, "-", token).pack(),
                ),
            ],
            [InlineKeyboardButton(text="⚙️ Качество", callback_data=f"q:{token}")],
        ]
    )


def quality_kb(token: str) -> InlineKeyboardMarkup:
    buttons = [
        InlineKeyboardButton(
            text=f"{q}p", callback_data=DownloadCallback(MODE_VIDEO, q, token).pack()
        )
        for q in QUALITY_CHOICES
    ]
    rows = [buttons[i : i + 3] for i in range(0, len(buttons), 3)]
    rows.append(
        [
            InlineKeyboardButton(
                text="🏆 Максимум",
                callback_data=DownloadCallback(MODE_VIDEO, "max", token).pack(),
            ),
            InlineKeyboardButton(
                text="🎵 Аудио",
                callback_data=DownloadCallback(MODE_AUDIO, "-", token).pack(),
            ),
        ]
    )
    return InlineKeyboardMarkup(inline_keyboard=rows)


def fallback_kb(token: str, current_quality: str) -> InlineKeyboardMarkup:
    """Offered when a file did not fit into the Telegram upload limit."""
    lower = [q for q in ("720", "480", "360") if _rank(q) < _rank(current_quality)]
    rows = [
        [
            InlineKeyboardButton(
                text=f"🎬 {q}p", callback_data=DownloadCallback(MODE_VIDEO, q, token).pack()
            )
            for q in lower
        ]
    ] if lower else []
    rows.append(
        [
            InlineKeyboardButton(
                text="🎵 Только звук",
                callback_data=DownloadCallback(MODE_AUDIO, "-", token).pack(),
            )
        ]
    )
    return InlineKeyboardMarkup(inline_keyboard=rows)


def _rank(quality: str) -> int:
    if quality == "max":
        return 10_000
    try:
        return int(quality)
    except ValueError:
        return 0
