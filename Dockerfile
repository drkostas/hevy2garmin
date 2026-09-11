FROM python:3.12-slim AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

# Toolchain for dependencies that fall back to an sdist when no wheel matches
# the platform — pynacl, curl-cffi and psycopg2 all do this on arm64, so a
# plain `pip install .` fails on a Raspberry Pi. Confined to this stage so the
# compiler never ships in the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential libffi-dev \
 && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src/ src/

RUN pip install --no-cache-dir .


FROM python:3.12-slim

# Run unprivileged: a container escape starts as uid 999 rather than root, and
# files written into a bind mount are not root-owned on the host.
#
# HOME stays /root on purpose. Every path the app uses is HOME-relative
# (~/.hevy2garmin, ~/.garminconnect), so keeping HOME means the volume paths in
# the README keep working exactly as before — this is not a breaking change for
# existing installs. The directory is handed to the new user instead.
RUN groupadd --system --gid 999 nonroot \
 && useradd --system --gid 999 --uid 999 --home-dir /root --no-create-home nonroot \
 && mkdir -p /root/.hevy2garmin /root/.garminconnect \
 && chown -R 999:999 /root \
 && chmod 755 /root

# Only the finished virtualenv crosses over — no build tools, no sources.
COPY --from=builder /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/root

USER nonroot
WORKDIR /app



ENTRYPOINT ["hevy2garmin"]
CMD ["status"]
