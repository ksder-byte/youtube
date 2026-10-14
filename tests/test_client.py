"""Integration tests against a fake Cobalt instance served by aiohttp."""

from __future__ import annotations

import asyncio

import pytest
from aiohttp import web

from app.cobalt import CobaltClient, CobaltError, CobaltUnavailable
from app.downloader import EmptyDownload, FileTooLarge, download_file


@pytest.fixture
async def server():
    """Starts a throwaway HTTP server exposing a minimal Cobalt-like API."""
    state: dict = {"requests": []}

    async def api(request: web.Request) -> web.Response:
        body = await request.json()
        state["requests"].append((dict(request.headers), body))
        if "unsupported" in body["url"]:
            return web.json_response(
                {"status": "error", "error": {"code": "error.api.service.unsupported"}},
                status=400,
            )
        if "garbage" in body["url"]:
            return web.Response(text="<html>502</html>", status=502)
        return web.json_response(
            {"status": "tunnel", "url": f"{request.url.origin()}/file", "filename": "clip.mp4"}
        )

    async def info(request: web.Request) -> web.Response:
        return web.json_response({"cobalt": {"version": "11.7.1", "services": ["youtube"]}})

    async def file(request: web.Request) -> web.Response:
        return web.Response(
            body=b"x" * 4096,
            headers={"Content-Disposition": 'attachment; filename="Rick Astley.mp4"'},
        )

    async def big(request: web.Request) -> web.Response:
        return web.Response(body=b"x" * 4096, headers={"Content-Length": "4096"})

    async def empty(request: web.Request) -> web.Response:
        # Exactly what a dead Cobalt remux looks like: 200 OK, zero bytes.
        return web.Response(body=b"", headers={"Content-Type": "video/mp4"})

    async def chunked(request: web.Request) -> web.StreamResponse:
        response = web.StreamResponse()
        await response.prepare(request)
        for _ in range(8):
            await response.write(b"y" * 1024)
        await response.write_eof()
        return response

    app = web.Application()
    app.router.add_post("/", api)
    app.router.add_get("/", info)
    app.router.add_get("/file", file)
    app.router.add_get("/big", big)
    app.router.add_get("/empty", empty)
    app.router.add_get("/chunked", chunked)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    state["url"] = f"http://127.0.0.1:{port}"
    try:
        yield state
    finally:
        await runner.cleanup()


@pytest.fixture
async def client(server):
    client = CobaltClient([server["url"]], api_key="secret", api_timeout=10, download_timeout=10)
    await client.start()
    try:
        yield client
    finally:
        await client.close()


async def test_server_info(client):
    info = await client.server_info()
    assert info["cobalt"]["version"] == "11.7.1"


async def test_process_returns_tunnel_and_sends_auth(client, server):
    result = await client.process("https://youtu.be/dQw4w9WgXcQ")
    assert result.status == "tunnel"
    assert result.filename == "clip.mp4"

    headers, body = server["requests"][-1]
    assert headers["Authorization"] == "Api-Key secret"
    assert body["url"] == "https://youtu.be/dQw4w9WgXcQ"
    assert body["localProcessing"] == "disabled"
    assert body["videoQuality"] == "1080"


async def test_audio_mode_is_forwarded(client, server):
    await client.process("https://youtu.be/x", download_mode="audio", audio_format="mp3")
    _, body = server["requests"][-1]
    assert body["downloadMode"] == "audio"
    assert body["audioFormat"] == "mp3"


async def test_error_status_raises_cobalt_error(client):
    with pytest.raises(CobaltError) as excinfo:
        await client.process("https://example.com/unsupported")
    assert excinfo.value.code == "error.api.service.unsupported"


async def test_non_json_response_raises_unavailable(client):
    with pytest.raises(CobaltUnavailable):
        await client.process("https://example.com/garbage")


async def test_download_uses_content_disposition(client, server, tmp_path):
    path = await download_file(
        client.session, f"{server['url']}/file", tmp_path, limit_bytes=1024 * 1024
    )
    assert path.name == "Rick Astley.mp4"
    assert path.stat().st_size == 4096


async def test_download_rejects_declared_oversize(client, server, tmp_path):
    with pytest.raises(FileTooLarge) as excinfo:
        await download_file(client.session, f"{server['url']}/big", tmp_path, limit_bytes=1024)
    assert excinfo.value.size_bytes == 4096


async def test_download_aborts_mid_stream_and_cleans_up(client, server, tmp_path):
    with pytest.raises(FileTooLarge):
        await download_file(
            client.session,
            f"{server['url']}/chunked",
            tmp_path,
            limit_bytes=2048,
            fallback_name="stream.mp4",
        )
    assert list(tmp_path.iterdir()) == []


async def test_empty_body_raises_and_leaves_no_file(client, server, tmp_path):
    with pytest.raises(EmptyDownload):
        await download_file(
            client.session,
            f"{server['url']}/empty",
            tmp_path,
            limit_bytes=1024 * 1024,
            fallback_name="clip.mp4",
        )
    assert list(tmp_path.iterdir()) == []


async def test_local_processing_is_forwarded(client, server):
    await client.process("https://youtu.be/x", local_processing="preferred")
    _, body = server["requests"][-1]
    assert body["localProcessing"] == "preferred"


async def test_better_audio_is_off_by_default(client, server):
    await client.process("https://youtu.be/x")
    _, body = server["requests"][-1]
    assert body["youtubeBetterAudio"] is False


# --------------------------------------------------------------------------- #
# instance failover
# --------------------------------------------------------------------------- #

@pytest.fixture
async def spawn():
    """Starts throwaway instances that behave the way a real one might misbehave."""
    runners: list[web.AppRunner] = []

    async def factory(mode: str) -> dict:
        state = {"hits": 0, "mode": mode}

        async def api(request: web.Request) -> web.Response:
            state["hits"] += 1
            if state["mode"] == "youtube_error":
                return web.json_response(
                    {"status": "error", "error": {"code": "error.api.youtube.no_session_tokens"}},
                    status=400,
                )
            if state["mode"] == "link_error":
                return web.json_response(
                    {"status": "error", "error": {"code": "error.api.link.invalid"}}, status=400
                )
            if state["mode"] == "rate_limited":
                return web.json_response({"status": "error"}, status=429)
            if state["mode"] == "boom":
                return web.json_response({"status": "error"}, status=503)
            return web.json_response(
                {"status": "tunnel", "url": f"{request.url.origin()}/file", "filename": "clip.mp4"}
            )

        app = web.Application()
        app.router.add_post("/", api)
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", 0).start()
        runners.append(runner)
        state["url"] = f"http://127.0.0.1:{runner.addresses[0][1]}"
        return state

    try:
        yield factory
    finally:
        for runner in runners:
            await runner.cleanup()


async def make_client(*urls: str) -> CobaltClient:
    client = CobaltClient(list(urls), api_timeout=5, download_timeout=5)
    await client.start()
    return client


async def test_failover_when_the_primary_has_no_youtube_session(spawn):
    broken = await spawn("youtube_error")
    good = await spawn("ok")
    client = await make_client(broken["url"], good["url"])
    try:
        result = await client.process("https://youtu.be/x")
        assert result.status == "tunnel"
        assert result.source == client.endpoints[1].label
        assert broken["hits"] == 1 and good["hits"] == 1
    finally:
        await client.close()


async def test_no_failover_when_the_link_itself_is_bad(spawn):
    broken = await spawn("link_error")
    good = await spawn("ok")
    client = await make_client(broken["url"], good["url"])
    try:
        with pytest.raises(CobaltError) as excinfo:
            await client.process("https://example.com/nope")
        assert excinfo.value.code == "error.api.link.invalid"
        # A bad link is bad everywhere: the fallback must not be bothered.
        assert good["hits"] == 0
    finally:
        await client.close()


async def test_rate_limited_instance_is_benched(spawn):
    limited = await spawn("rate_limited")
    good = await spawn("ok")
    client = await make_client(limited["url"], good["url"])
    try:
        assert (await client.process("https://youtu.be/x")).status == "tunnel"
        assert client.endpoints[0].healthy is False

        # The next request skips the benched instance entirely.
        await client.process("https://youtu.be/y")
        assert limited["hits"] == 1 and good["hits"] == 2
    finally:
        await client.close()


async def test_server_error_falls_over(spawn):
    dying = await spawn("boom")
    good = await spawn("ok")
    client = await make_client(dying["url"], good["url"])
    try:
        assert (await client.process("https://youtu.be/x")).source == client.endpoints[1].label
    finally:
        await client.close()


async def test_unreachable_instance_falls_over(spawn):
    good = await spawn("ok")
    client = await make_client("http://127.0.0.1:1", good["url"])
    try:
        assert (await client.process("https://youtu.be/x")).status == "tunnel"
        assert good["hits"] == 1
    finally:
        await client.close()


async def test_all_instances_refusing_reports_the_reason(spawn):
    first = await spawn("youtube_error")
    second = await spawn("youtube_error")
    client = await make_client(first["url"], second["url"])
    try:
        with pytest.raises(CobaltError) as excinfo:
            await client.process("https://youtu.be/x")
        assert excinfo.value.code == "error.api.youtube.no_session_tokens"
        assert first["hits"] == 1 and second["hits"] == 1
    finally:
        await client.close()


async def test_single_instance_server_error_is_reported(spawn):
    only = await spawn("boom")
    client = await make_client(only["url"])
    try:
        with pytest.raises(CobaltUnavailable):
            await client.process("https://youtu.be/x")
    finally:
        await client.close()


async def test_lone_unreachable_instance_is_retried_then_reported():
    client = await make_client("http://127.0.0.1:1")
    try:
        with pytest.raises(CobaltUnavailable):
            await client.process("https://youtu.be/x")
    finally:
        await client.close()


async def test_benched_instance_is_still_used_when_nothing_else_is_left(spawn):
    only = await spawn("ok")
    client = await make_client(only["url"])
    client.endpoints[0].mark_unhealthy()
    try:
        assert (await client.process("https://youtu.be/x")).status == "tunnel"
    finally:
        await client.close()


# --------------------------------------------------------------------------- #
# diagnosing instances that answer something other than the API
# --------------------------------------------------------------------------- #

@pytest.fixture
async def odd_server():
    """An instance that serves a frontend at / and the real API at /api."""

    async def frontend(request: web.Request) -> web.Response:
        return web.Response(text="<!DOCTYPE html><html><body>cobalt</body></html>",
                            content_type="text/html")

    async def cloudflare(request: web.Request) -> web.Response:
        return web.Response(text="<html><title>Just a moment...</title></html>",
                            content_type="text/html", status=403)

    async def api(request: web.Request) -> web.Response:
        return web.json_response({"cobalt": {"version": "11.7.1", "services": ["youtube"]}})

    async def not_cobalt(request: web.Request) -> web.Response:
        return web.json_response({"hello": "world"})

    app = web.Application()
    app.router.add_get("/", frontend)
    app.router.add_get("/api/", api)
    app.router.add_get("/blocked/", cloudflare)
    app.router.add_get("/other/", not_cobalt)

    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    try:
        yield f"http://127.0.0.1:{runner.addresses[0][1]}"
    finally:
        await runner.cleanup()


async def test_probe_explains_html_answer(odd_server):
    client = await make_client(odd_server)
    try:
        probe = await client.probe(client.endpoints[0])
        assert probe.ok is False
        assert "HTML" in probe.error
        assert probe.http_status == 200
        assert "<!DOCTYPE html" in probe.snippet
    finally:
        await client.close()


async def test_probe_names_cloudflare(odd_server):
    client = await make_client(f"{odd_server}/blocked")
    try:
        probe = await client.probe(client.endpoints[0])
        assert "Cloudflare" in probe.error
    finally:
        await client.close()


async def test_probe_rejects_json_that_is_not_cobalt(odd_server):
    client = await make_client(f"{odd_server}/other")
    try:
        probe = await client.probe(client.endpoints[0])
        assert probe.ok is False
        assert "не ответ Cobalt" in probe.error
    finally:
        await client.close()


async def test_probe_accepts_the_real_api(odd_server):
    client = await make_client(f"{odd_server}/api")
    try:
        probe = await client.probe(client.endpoints[0])
        assert probe.ok is True
        assert probe.version == "11.7.1"
        assert probe.supports_youtube is True
    finally:
        await client.close()


async def test_checker_suggests_the_api_path(odd_server):
    """Pointed at a frontend, the CLI must find the API next door."""
    from app.instances import check

    client = await make_client(odd_server)
    try:
        report = await check(client, client.endpoints[0], test_youtube=False)
        assert "отвечает" in report and "/api" in report
    finally:
        await client.close()


async def test_server_info_reports_non_json_clearly(odd_server):
    client = await make_client(odd_server)
    try:
        with pytest.raises(CobaltUnavailable) as excinfo:
            await client.server_info()
        assert "not JSON" in str(excinfo.value)
    finally:
        await client.close()


async def test_always_proxy_is_forwarded(client, server):
    await client.process("https://youtu.be/x", always_proxy=False)
    _, body = server["requests"][-1]
    assert body["alwaysProxy"] is False
