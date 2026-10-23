#!/usr/bin/env sh
# traefik-certs-dumper v2 with --domain-subdir=false writes:
#   /certs/certs/<domain>.pem and /certs/private/<domain>.pem
# NearTRIP expects fixed names; copy PUBLIC_HOSTNAME's PEMs into place.
set -eu

dest="${NTRIPS_CERT_DIR:-/certs}"
domain="${PUBLIC_HOSTNAME:-}"
if [ -z "$domain" ]; then
  echo "ntrips-publish-traefik-certs: PUBLIC_HOSTNAME is required" >&2
  exit 1
fi

src_cert="$dest/certs/${domain}.pem"
src_key="$dest/private/${domain}.pem"

publish() {
  if [ -f "$src_cert" ] && [ -f "$src_key" ]; then
    cp -f "$src_cert" "$dest/cert.pem"
    cp -f "$src_key" "$dest/key.pem"
    chmod 644 "$dest/cert.pem"
    chmod 600 "$dest/key.pem"
    echo "ntrips-publish-traefik-certs: wrote $dest/cert.pem and $dest/key.pem"
  fi
}

publish
while true; do
  sleep 5
  publish
done
