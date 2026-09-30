#!/usr/bin/env sh
# Generate strong random secrets for docker compose. Safe to re-run: existing files are kept.
set -eu
cd "$(dirname "$0")/../secrets"
gen() { [ -s "$1" ] || { head -c 32 /dev/urandom | base64 | tr -d '/+=\n' | head -c 40 > "$1"; echo "created secrets/$1"; }; }
gen auth_password.txt
gen internal_token.txt
gen redis_password.txt
gen grafana_password.txt
chmod 644 ./*.txt  # containers run as non-root UIDs and must read these bind-mounted files
chmod 700 .   # the directory is the access boundary on the host
echo "Login user: bookmind   password: $(cat auth_password.txt)"

# (tls.key and the .txt files are 0644 because the containers run as non-root UIDs; the 0700 secrets/
# directory keeps other host users out.)
# Self-signed TLS certificate for the edge proxy. Browsers only enable service workers (offline
# mode) on HTTPS or localhost; for phones on your LAN, prefer a locally-trusted cert from
# `mkcert` (write it to secrets/tls.crt + secrets/tls.key) or a real one from Let's Encrypt.
if [ ! -s tls.crt ]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=bookmind.local" \
      -addext "subjectAltName=DNS:localhost,DNS:bookmind.local,IP:127.0.0.1" \
      -keyout tls.key -out tls.crt 2>/dev/null && chmod 644 tls.crt tls.key && echo "created secrets/tls.crt (self-signed)"
  else
    echo "openssl not found: put a certificate at secrets/tls.crt and key at secrets/tls.key"
  fi
fi
