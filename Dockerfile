FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/config

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src/ src/

RUN pip install --no-cache-dir . \
    && mkdir -p /config \
    && chmod -R 777 /config

EXPOSE 8123

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8123/login', timeout=3)" || exit 1

ENTRYPOINT ["hevy2garmin"]
CMD ["serve"]
