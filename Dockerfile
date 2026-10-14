FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ffmpeg/ffprobe: video metadata, thumbnails and the local-processing fallback.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# yt-dlp[deno] brings the deno binary along: yt-dlp needs a JavaScript runtime
# to solve YouTube's challenges.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && deno --version

COPY app ./app

RUN useradd --create-home --uid 10001 botuser \
    && chown -R botuser:botuser /app
USER botuser

# Only listened on with BOT_MODE=worker.
EXPOSE 8080

CMD ["python", "-m", "app"]
