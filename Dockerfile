# syntax=docker/dockerfile:1
# SPDX-License-Identifier: AGPL-3.0-or-later
# One image for every service; choose with SERVICE=gateway|catalog|search|research|notebook|websearch|tts|all.
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt requirements-otel.txt ./
# Behind a TLS-intercepting corporate proxy? Pass its CA without baking it into the image:
#   docker build --secret id=ca,src=/path/to/ca.crt .
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export PIP_CERT=/run/secrets/ca; fi; \
    pip install -r requirements.txt -r requirements-otel.txt

COPY bookmind/ bookmind/
COPY tools/voices.py tools/voices.py
COPY web/ web/
COPY data/chunks.json data/chunks.json
COPY deploy/config/flags.json deploy/config/flags.json

# Non-root, fixed UID (Kubernetes runAsNonRoot), and the only writable path is /app/var so the
# root filesystem can be mounted read-only.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app \
 && mkdir -p /app/var/voices && chown -R 10001:10001 /app/var
USER 10001

ENV SERVICE=gateway \
    BOOKMIND_DB_PATH=/app/var/notebook.db
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)"
STOPSIGNAL SIGTERM
CMD ["python", "-m", "bookmind.serve"]
