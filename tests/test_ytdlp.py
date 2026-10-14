"""yt-dlp backend tests with a stubbed YoutubeDL — no network involved."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from app.ytdlp import (
    Progress,
    YtDlpError,
    YtDlpTooLarge,
    build_format,
    build_options,
    download,
    explain,
    is_youtube,
)


class FakeYoutubeDL:
    """Mimics the slice of the yt-dlp API the backend actually uses."""

    def __init__(self, options: dict[str, Any]) -> None:
        self.options = options
        self.calls: list[bool] = []

    # Injected per test.
    info: dict[str, Any] = {}
    raises: Exception | None = None
    writes: tuple[str, bytes] | None = None

    def __enter__(self) -> "FakeYoutubeDL":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def extract_info(self, url: str, download: bool = False) -> dict[str, Any]:
        self.calls.append(download)
        if self.raises is not None and download:
            raise self.raises
        if download and self.writes:
            name, payload = self.writes
            target = Path(self.options["outtmpl"]).parent / name
            target.write_bytes(payload)
        return self.info

    def prepare_filename(self, info: dict[str, Any]) -> str:
        directory = Path(self.options["outtmpl"]).parent
        return str(directory / f"{info.get('title', 'video')}.{info.get('ext', 'mp4')}")


def make_factory(**attrs: Any):
    def factory(options: dict[str, Any]) -> FakeYoutubeDL:
        instance = FakeYoutubeDL(options)
        for key, value in attrs.items():
            setattr(instance, key, value)
        return instance

    return factory


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://youtu.be/dQw4w9WgXcQ", True),
        ("https://www.youtube.com/watch?v=x", True),
        ("https://m.youtube.com/shorts/x", True),
        ("https://music.youtube.com/watch?v=x", True),
        ("https://vimeo.com/1", False),
        ("https://notyoutube.com/watch?v=x", False),
        ("https://youtube.com.evil.example/x", False),
        ("not a url", False),
    ],
)
def test_is_youtube(url, expected):
    assert is_youtube(url) is expected


def test_format_prefers_h264_and_respects_quality():
    selector = build_format("video", "720")
    assert "height<=720" in selector
    assert "avc1" in selector
    assert "avc1" not in build_format("video", "720", prefer_h264=False)
    assert build_format("video", "max").count("height") == 0
    assert build_format("audio", "1080") == "bestaudio/best"


def test_audio_mode_adds_the_extract_postprocessor(tmp_path):
    options = build_options(
        tmp_path, mode="audio", quality="1080", limit_bytes=1000,
        audio_format="mp3", audio_bitrate="192",
    )
    processor = options["postprocessors"][0]
    assert processor["key"] == "FFmpegExtractAudio"
    assert processor["preferredcodec"] == "mp3"
    assert processor["preferredquality"] == "192"
    assert "merge_output_format" not in options


def test_video_mode_merges_into_mp4_and_caps_size(tmp_path):
    options = build_options(tmp_path, mode="video", quality="1080", limit_bytes=52_428_800)
    assert options["merge_output_format"] == "mp4"
    assert options["max_filesize"] == 52_428_800
    assert options["noplaylist"] is True


def test_cookies_file_is_passed_through(tmp_path):
    options = build_options(
        tmp_path, mode="video", quality="720", limit_bytes=1, cookies_file="/cookies.txt"
    )
    assert options["cookiefile"] == "/cookies.txt"


async def test_download_returns_metadata(tmp_path):
    factory = make_factory(
        info={"title": "clip", "ext": "mp4", "duration": 12.7, "width": 1920, "height": 1080,
              "uploader": "someone", "filesize": 1024},
        writes=("clip.mp4", b"x" * 1024),
    )
    result = await download(
        "https://youtu.be/x", tmp_path, mode="video", quality="1080",
        limit_bytes=10_000, ytdl_factory=factory,
    )
    assert result.path.name == "clip.mp4"
    assert result.duration == 12 and result.height == 1080
    assert result.title == "clip"


async def test_download_refuses_oversize_before_downloading(tmp_path):
    factory = make_factory(info={"title": "big", "ext": "mp4", "filesize": 900_000_000})
    with pytest.raises(YtDlpTooLarge) as excinfo:
        await download(
            "https://youtu.be/x", tmp_path, mode="video", quality="1080",
            limit_bytes=50_000_000, ytdl_factory=factory,
        )
    assert excinfo.value.size_bytes == 900_000_000
    assert not list(tmp_path.iterdir())  # nothing was fetched


async def test_size_of_split_formats_is_summed(tmp_path):
    factory = make_factory(
        info={"title": "split", "ext": "mp4",
              "requested_formats": [{"filesize": 30_000_000}, {"filesize": 25_000_000}]},
    )
    with pytest.raises(YtDlpTooLarge):
        await download(
            "https://youtu.be/x", tmp_path, mode="video", quality="1080",
            limit_bytes=50_000_000, ytdl_factory=factory,
        )


async def test_empty_result_is_an_error_not_an_upload(tmp_path):
    factory = make_factory(
        info={"title": "empty", "ext": "mp4"}, writes=("empty.mp4", b""),
    )
    with pytest.raises(YtDlpError, match="пустой"):
        await download(
            "https://youtu.be/x", tmp_path, mode="video", quality="1080",
            limit_bytes=10_000, ytdl_factory=factory,
        )


async def test_postprocessed_file_is_found_under_its_new_name(tmp_path):
    """mp3 extraction renames the file; prepare_filename still says .webm."""
    factory = make_factory(
        info={"title": "song", "ext": "webm", "duration": 200},
        writes=("song.mp3", b"id3" * 100),
    )
    result = await download(
        "https://youtu.be/x", tmp_path, mode="audio", quality="1080",
        limit_bytes=10_000, ytdl_factory=factory,
    )
    assert result.path.suffix == ".mp3"


async def test_playlist_takes_the_first_entry(tmp_path):
    factory = make_factory(
        info={"_type": "playlist", "entries": [
            {"title": "first", "ext": "mp4", "filesize": 10},
            {"title": "second", "ext": "mp4"},
        ]},
        writes=("first.mp4", b"data"),
    )
    result = await download(
        "https://youtu.be/x", tmp_path, mode="video", quality="720",
        limit_bytes=10_000, ytdl_factory=factory,
    )
    assert result.title == "first"


async def test_download_error_is_translated(tmp_path):
    factory = make_factory(
        info={"title": "x", "ext": "mp4"},
        raises=RuntimeError("ERROR: [youtube] x: Private video. Sign in if you've been granted access"),
    )
    with pytest.raises(YtDlpError) as excinfo:
        await download(
            "https://youtu.be/x", tmp_path, mode="video", quality="1080",
            limit_bytes=10_000, ytdl_factory=factory,
        )
    assert excinfo.value.hint == "❌ Видео приватное."


async def test_max_filesize_abort_becomes_too_large(tmp_path):
    factory = make_factory(
        info={"title": "x", "ext": "mp4"},
        raises=RuntimeError("File is larger than max-filesize (99 > 50)"),
    )
    with pytest.raises(YtDlpTooLarge):
        await download(
            "https://youtu.be/x", tmp_path, mode="video", quality="1080",
            limit_bytes=50, ytdl_factory=factory,
        )


@pytest.mark.parametrize(
    ("message", "needle"),
    [
        ("Sign in to confirm you're not a bot", "cookies"),
        ("Sign in to confirm your age", "возрастным"),
        ("Video unavailable", "недоступно"),
        ("This live event will begin in 2 hours", "не началась"),
        ("Requested format is not available", "качество"),
        ("something nobody has seen before", "yt-dlp не смог"),
    ],
)
def test_error_messages_are_actionable(message, needle):
    assert needle in explain(message)


def test_progress_percent():
    progress = Progress(downloaded=50, total=200)
    assert progress.percent == 25
    assert Progress(downloaded=5, total=None).percent is None
    assert Progress(downloaded=300, total=200).percent == 100
