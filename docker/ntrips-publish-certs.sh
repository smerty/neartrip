#!/usr/bin/env bash
# Copy lego-issued PEMs to the names NearTRIP expects (/certs/cert.pem, key.pem).
# Mounted as the acme-lego-cron hook; lego sets LEGO_CERT_PATH / LEGO_CERT_KEY_PATH.
set -Eeuo pipefail

dest="${NTRIPS_CERT_DIR:-/certs}"
mkdir -p "$dest"

if [[ -n "${LEGO_CERT_PATH:-}" && -n "${LEGO_CERT_KEY_PATH:-}" ]]; then
  cp -f "$LEGO_CERT_PATH" "$dest/cert.pem"
  cp -f "$LEGO_CERT_KEY_PATH" "$dest/key.pem"
elif [[ -n "${DOMAINS:-}" ]]; then
  # Fallback if the hook runs without LEGO_* vars: first domain in the list.
  domain="${DOMAINS%%;*}"
  domain="${domain#\*.}"
  src="${LEGO_PATH:-/letsencrypt}/certificates"
  cp -f "$src/${domain}.crt" "$dest/cert.pem"
  cp -f "$src/${domain}.key" "$dest/key.pem"
else
  echo "ntrips-publish-certs: no LEGO_CERT_PATH/LEGO_CERT_KEY_PATH or DOMAINS" >&2
  exit 1
fi

chmod 644 "$dest/cert.pem"
chmod 600 "$dest/key.pem"
echo "ntrips-publish-certs: wrote $dest/cert.pem and $dest/key.pem"
