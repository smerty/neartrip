# NearTRIP - Smart NTRIP Proxy

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](https://github.com/smerty/neartrip)

NearTRIP is an intelligent NTRIP proxy that automatically connects to the closest NTRIP base station based on the user's current location. It acts as an NTRIP server to GNSS receivers while connecting as a client to upstream NTRIP casters.

## Features

- 🌍 Automatically selects the closest NTRIP base station
- 🔄 Seamlessly switches between base stations as the user's location changes
- 🔌 Acts as an NTRIP server that can be used with any GNSS receiver
- 📊 Logs NMEA messages for diagnostic purposes
- 🚀 Simple setup and configuration
- 🔥 Hot reloading of configuration (change stations without server restart)
- 🧑‍💻 Web UI to manage it all

## Use Cases

- RTK corrections for precision agriculture
- UAV ground control stations needing RTK data
- Mobile mapping applications
- Any application needing RTK corrections from the closest base station

## Installation

1. Clone this repository:
   ```
   git clone https://github.com/smerty/neartrip.git
   cd neartrip
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Build the NTRIP core:
   ```
   cargo build --release
   ```

4. Create configuration file:
   ```
   cp config.json.sample config.json
   ```

5. Edit `config.json` with your settings and available NTRIP stations.

## Configuration

The `config.json` file contains all the settings needed to run NearTRIP:

```json
{
  "username": "your_ntrip_username",
  "password": "your_ntrip_password",
  "interface": "0.0.0.0",
  "port": 2101,
  "mountPoint": "NEAR-Station",
  "userAgent": "NearTRIP/1.0",
  "adminPort": 3000,
  "adminUsername": "your_adminui_username",
  "adminPassword": "your_adminui_password",
  "stations": [
    {
      "mountPoint": "STATION1",
      "casterHost": "example-caster.com",
      "casterPort": 2101,
      "username": "station_username",
      "password": "station_password",
      "latitude": 37.123,
      "longitude": -122.456,
      "active": true
    },
    // Add more stations as needed
  ]
}
```

### Hot Reloading Configuration

NearTRIP supports hot reloading of configuration, allowing you to modify settings without restarting the server or disrupting existing connections:

1. Edit the `config.json` file while the server is running
2. Save the file
3. Changes are automatically detected and applied

You can:
- Add or remove stations
- Change station details (coordinates, credentials, active status)
- Update server settings

Existing client connections stay up. Station changes apply on the next GGA sentence. Changes to the listen port, bind address, or admin password apply on the next process start.

## Usage

Start the admin UI and the Rust NTRIP core:

```
npm start
```

`npm start` runs the admin UI and the `neartrip` binary (`target/release/neartrip`, then `target/debug/neartrip`, then `neartrip` on `PATH`). Connect a GNSS receiver to the address and port in `config.json`. The core reads the same `config.json` the admin UI writes, and it reloads station changes without a restart.

Set `username` and `password` in `config.json` to require those credentials on the virtual mountpoint. Leave both empty to accept unauthenticated rovers. The admin UI is still the Node process on `adminPort` (default 3000).

### Caster resource limits

The TCP NTRIP listener remains on port 2101 by default, including compatibility
with the SparkFun RTK Express. Optional `connectionLimits` settings hot reload:

```json
"connectionLimits": {
  "maxConnections": 4096,
  "maxPendingHandshakes": 256,
  "maxPendingPerIp": 32,
  "handshakeTimeoutSeconds": 10
}
```

`maxConnections` includes established and pending sockets. Pending handshakes
have a separate global/per-IP allowance and an absolute deadline that incoming
bytes cannot extend. Successful rover/publisher authentication releases the
pending allowance before the success response; there is no per-IP established
rover limit, allowing shared cellular addresses.
At capacity, new sockets close without allocating a session or log task.
The total connection limit is at most 8192, pending at most 1024, and handshake
timeout 1–60 seconds. Pending limits must fit inside the total limit.

Session records retain at most 16,384 entries and seven days of closed history;
active sessions are never evicted. A closed-session queue and swap removal keep
capacity eviction constant-time without reindexing the registry. Log deletion
runs outside the registry mutex; eviction also signals detached writers so files
created late are removed rather than orphaned.
NMEA files are created only when a rover emits valid position data, with a 1 MiB
limit per session and a bounded write queue. Logging stops at that limit while
correction streaming continues. Session cleanup runs on errors, cancellation,
and task panic. Invalid/non-ASCII checksums and oversized NMEA lines are rejected.

### Multiple rover users

Add a `users` array in the Settings configuration editor or `config.json`:

```json
"users": [
  { "username": "tractor", "password": "tractor-secret" },
  { "username": "survey", "password": "survey-secret", "active": true }
]
```

Each rover uses its own login on the same virtual mountpoint. Concurrent rovers
select stations independently from their own GGA positions. A nonempty `users`
list replaces the legacy top-level `username` and `password`; only active users
can connect. Set `active` to `false` to disable an account (defaults to `true`).
An all-disabled list rejects every rover. Omit `users` or use `[]` to retain the
legacy login behavior, including anonymous access when both legacy fields are
empty. Account changes hot reload for new connections; existing sessions stay
connected. These accounts grant rover access only; admin credentials are separate.

## How it Works

1. Your GNSS receiver connects to NearTRIP as if it were a standard NTRIP server
2. The receiver sends its location via NMEA GPGGA sentences
3. NearTRIP analyzes the location to find the closest base station
4. NearTRIP connects to the selected base station as an NTRIP client
5. RTK correction data from the base station is forwarded to your receiver
6. As you move, NearTRIP automatically switches to the closest station

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Connection diagnostics

The Rust core publishes `logs/sessions.json` at most once a second; the admin
Connections view refreshes every five seconds. Connected sockets include TCP
probes. Active rovers have passed the mountpoint/authentication checks, including
when authentication is disabled. A streaming rover has forwarded correction bytes
on its current upstream connection. `bytesSent` counts correction payload only;
`bytesReceived` includes the request and NMEA data.

Clients wait for a valid GGA before a station can be selected. The view exposes
last GGA time, upstream state and last error, the 120-second inbound idle limit,
and the reason a session ended. Correction traffic does not reset the client's
inbound idle timer. Timestamps include the local date so seven-day history is
unambiguous.

The core writes timestamped upstream events to stdout (inherited by Node and
available through `docker compose logs` under Compose). Default `info` logging
includes the rover connection `id`, mountpoint, dial attempts and results, first
correction bytes, and read/write failures. Read failures include the OS error,
connection lifetime, time since last correction bytes, and byte count. Match
`id` to the Connections view. NMEA downloads still contain only NMEA sentences;
the displayed last upstream error can remain visible after recovery.

Established upstream connections that close or fail are redialed immediately
using the latest valid GGA. Failed dial or initial GGA attempts retry after five
seconds on a timer, without waiting for another rover sentence. Reusing GGA does
not refresh the rover's 120-second inbound idle deadline.

History survives restarts, retaining disconnected sessions for seven days from
their disconnect time. Sessions still marked active at startup are recovered as
interrupted (`core restarted`). Orderly shutdown records `core shutdown`. Invalid
history is preserved beside the snapshot as `sessions.json.corrupt-<id>` before
starting a fresh table; unreadable history stops startup rather than overwriting
it. Live sessions are retained regardless of age.

Run the core and dashboard regression suites with `cargo test` and
`npm run test:admin`. The core tests use local mock casters and virtual time to
exercise long-lived rovers and idle timeouts without external NTRIP services.

### Direct base-station uploads

NearTRIP accepts base-station correction streams directly, without an upstream
caster. In **Stations → Direct Base Stations**, add a publisher with a unique
mountpoint, username, and password. Position is automatically detected from
CRC-checked RTCM 1005/1006 messages in the upload. The dashboard
can edit credentials and coordinates, enable or disable publishers, and delete
them. Leaving the password blank when editing preserves it. Optional manual
coordinates serve as a fallback until a valid base-position message arrives.
Detected coordinates take precedence and are not written into configuration.
If neither detected nor manual coordinates are available, the source can still
serve its fixed mountpoint but waits to participate in nearest selection.

The dashboard displays antenna reference point latitude, longitude, and height
above the WGS84 ellipsoid, plus the separate antenna-height field when provided
by message 1006. Ellipsoidal height is not elevation above sea level; that would
require a geoid model. We do not add the antenna-height field to the already
reported antenna reference point height. Configure the base to periodically
send 1005 or 1006; observation messages alone cannot supply its position.
Detection starts fresh for each upload connection, so a reconnect cannot inherit
a previous publisher's position. RTCM bytes are inspected without being changed.
Field layouts follow the [RTKLIB decoder](https://github.com/tomojitakasu/RTKLIB/blob/master/src/rtcm3.c).

The equivalent configuration in `config.json` or the Settings JSON editor is:

```json
"sources": [
  {
    "mountPoint": "MY_BASE",
    "username": "base1",
    "password": "replace-with-a-secret",
    "latitude": 37.123,
    "longitude": -122.456,
    "settlingSeconds": 60,
    "positionToleranceM": 5,
    "active": true
  }
]
```

Configure the base's NTRIP server/upload mode with host `rtk.k6sh.com`, the
configured TCP port (default 2101, or 2102 for NTRIPS), mountpoint `MY_BASE`,
and the publisher's credentials. The hostname must point to the deployed server
and its TCP port must be reachable. NTRIP v1 `SOURCE` uses the publisher
password; NTRIP v2 `POST` uses Basic authentication. Chunked uploads are
currently rejected (501); use an unchunked upload mode. A POST with
`Content-Length` ends at that body boundary and releases its mountpoint; bytes
after the body are discarded and the connection is closed rather than reused for
another request. Invalid or duplicate length headers are rejected before
accepting an upload. POST without a length and legacy SOURCE uploads continue
until disconnection or idle timeout.

### NTRIPS (TLS)

Plain NTRIP stays on `port` (default 2101). Optional in-process TLS listens on a
second port (default 2102). Clients connect to that port directly — Traefik on
80/443 only serves the admin UI and does **not** terminate NTRIPS.

```json
"tls": {
  "port": 2102,
  "certFile": "/certs/cert.pem",
  "keyFile": "/certs/key.pem"
}
```

Omit the `tls` block to keep a plain-only deployment. Certificate and key files
are reloaded automatically when their mtimes change. Publish host port **2102**
(firewall / security group) and point publishers at `PUBLIC_HOSTNAME:2102` with
TLS enabled (for example [rustk-caster](https://github.com/ppicazo/rustk-caster)
with `tls = true`).

#### Certificates without Traefik (recommended): DNS-01

Let's Encrypt via **DNS-01** needs a DNS provider API token that can create
temporary `_acme-challenge` TXT records. It does **not** use port 80 or 443, so
it works whether or not you run Traefik.

1. Copy [`.env.ntrips.example`](.env.ntrips.example) into your Compose `.env`
   (set `PUBLIC_HOSTNAME`, `NTRIPS_ACME_EMAIL`, `NTRIPS_DNS_PROVIDER`, and the
   provider token — Cloudflare example uses `CLOUDFLARE_DNS_API_TOKEN`).
   Other providers: [lego DNS docs](https://go-acme.github.io/lego/dns/).
2. Start with the DNS profile:
   ```bash
   docker compose --profile ntrips-dns up -d
   ```
3. When `/certs/cert.pem` and `/certs/key.pem` appear, add the `tls` block above
   and reload/restart the core if it was already running without TLS.

Use `NTRIPS_ACME_STAGING=1` for the first run against the staging CA, then set
it back to `0` for a production certificate.

#### Optional: reuse Traefik's certificate

If Traefik already has a Let's Encrypt cert for `PUBLIC_HOSTNAME`, you can dump
its PEMs instead of running DNS-01:

```bash
docker compose --profile ntrips-traefik up -d
```

Point `TRAEFIK_ACME_JSON` at Traefik's `acme.json`. Prefer DNS-01 when you are
not running Traefik, or when you want NTRIPS certs independent of the UI stack.

#### Manual PEMs

Any process that writes `cert.pem` / `key.pem` works (certbot DNS plugin,
acme.sh, a commercial cert). Mount them at the paths in the `tls` block; NearTRIP
picks up renewals when the files change.

Rovers use their normal rover credentials. Request `MY_BASE` for a fixed base
(no GGA required), or the existing virtual mountpoint for nearest-station
selection using GGA. Active direct mountpoints appear in the sourcetable.
Offline fixed mountpoints return 503, and duplicate publishers return 409.
Publisher mountpoints must be distinct from the virtual mountpoint and all
upstream stations; use letters, digits, underscores, periods, and hyphens.
The reserved names `.` and `..` are rejected.

### Direct-source onboarding

Each direct source has an independent onboarding status, shown alongside stream
health in **Stations → Direct Base Stations**:

- **Detecting:** waiting for stream data or a reported/manual position.
- **Settling:** checking the position over the configured settling period, with
  a countdown.
- **Ready:** eligible for automatic nearest-station selection while data remains
  fresh.
- **Needs attention:** offline, disabled, stale, position changed, or waiting for
  a confirming position report. The dashboard shows the reason.
- **Unknown:** core onboarding data is missing, expired, or uses different
  settings than the current configuration.

Edit a publisher's **Settling period (seconds)** and **Position tolerance (meters)**
in the dashboard or set `settlingSeconds` and `positionToleranceM` in its source
configuration. Defaults are 60 seconds and 5 meters. Settling accepts whole seconds
from 0 to 86400; tolerance must be greater than zero and at most 10000 meters.
Setting the period to zero skips the settling delay; position and fresh traffic
are still required.

For detected RTCM positions, a valid 1005/1006 report must confirm the position
at or after the end of the settling period. A single position message followed
by other traffic cannot establish position stability. If confirmation has not
arrived, the source shows **Needs attention** until a valid report arrives.
Manual fallback coordinates qualify after the period of continuous fresh data;
the administrator is responsible for those coordinates.

Positions are compared with the first position in the current qualification
window. Movement beyond the tolerance (horizontal distance combined with
ellipsoidal height change), a changed RTCM station ID, or a switch from manual
coordinates to a reported station position restarts qualification. Comparing
against an anchor also catches gradual drift. Movement removes a previously
ready source from nearest selection; clients can use another ready direct base
or an upstream station while it requalifies.

A gap of 10 seconds without data interrupts qualification; resumed data starts
a new settling period. Reconnection, restart, and publisher configuration edits
also start fresh. Fixed mountpoint clients remain available throughout onboarding
for diagnostics; onboarding gates automatic nearest selection only. This checks
reported position and traffic stability, not survey-in completion or coordinate
accuracy, and does not modify or average the base's correction messages.

Nearest selection combines upstream `stations` with enabled direct sources
that are **Ready**, have detected or fallback coordinates, and have received data
in the last 10 seconds. The existing
500-meter switch margin applies. Every second, source health is reevaluated
using the latest valid rover GGA, allowing failover and recovery without another
position report. Rover input still has the existing 120-second idle limit;
health checks do not extend it. When no base is available, the nearest connection
waits for a healthy source rather than replaying old corrections.

The dashboard refreshes source health every five seconds:
- **Waiting:** publisher connected but no data received.
- **Healthy:** data received less than 10 seconds ago.
- **Stale:** publisher connected, but data is at least 10 seconds old.
- **Offline:** no publisher connected.
- **Disabled:** publisher account disabled.
- **Unknown:** the core health snapshot is unavailable or at least five seconds old.

Health reports last data time, bytes received during the current/last upload,
subscriber count, and the last disconnect error. Health means data is arriving;
CRC checks on position messages do not establish surveyed accuracy or validate
the remaining correction messages.
The core atomically writes credential-free `logs/sources.json` every second
(overridable with `NEARTRIP_SOURCES` when running the core separately); the Node
launcher uses the shared logs directory. Source health starts fresh on restart,
unlike rover session history.

No data for 30 seconds disconnects the upload and its fixed subscribers.
Nearest clients can fail over earlier when data becomes stale. Each upload
feeds multiple rovers through bounded queues; streams are live only and are
never replayed. Disabling, deleting, or changing a publisher's account or
coordinates or onboarding settings closes its upload on config reload (normally within one second).
Its base must reconnect using the new settings. Fixed clients must reconnect
after their source goes away; nearest clients select another available station.
Existing upstream station support remains available during migration.

Run `cargo test` and `npm run test:admin` for the source health, fan-out,
nearest switching, onboarding admission/movement/recovery, stale-source
failover/recovery, and admin API regressions.

### Member directory and private administration

`/` is a members-only station directory and map. Unauthenticated visitors go
to `/login`; station metadata APIs require authentication too. `/admin` retains HTTP Basic Auth and
adds rover **Users**, **Statistics**, and **IP policy** pages. Map tiles use
OpenStreetMap; the map and fonts require internet access.

Create rover credentials in Users. Enabled accounts take precedence over the
legacy shared credentials; disabled accounts cannot authenticate. The UI prevents
removing the last account because an empty account list restores legacy shared
credentials (or anonymous access when those credentials are empty). Disabling or removing a rover account disconnects its sessions within roughly one second. Admin HTTP
credentials and direct publisher credentials remain separate.

Statistics aggregate direct-base uploads by mountpoint and rover downloads by
verified login, or peer IP for anonymous clients. Session counts, bytes, and
connection time are process-local and reset when the Rust core restarts. Each
category retains up to 10,000 identities, evicting inactive identities when full.
The core writes a private, atomic `logs/operations.json` snapshot every second
(`NEARTRIP_OPERATIONS` overrides it for both Node and the core; relative paths
resolve from the Node launch directory); the admin API rejects snapshots older than
five seconds. These snapshots are never restored into memory.

Automatic soft bans are **off by default**. When enabled, the defaults require
20 authentication failures within five minutes and ban for ten minutes.
Malformed requests and ordinary disconnects alone do not trigger a ban.
Loopback, allowlisted addresses, active authenticated peers, and peers with a
successful authentication in the preceding 30 minutes are exempt from automatic
bans. Manual temporary/permanent bans override these exemptions. Ban checks use
the TCP peer address, so shared NAT or a TCP proxy can group multiple users under
one IP; allowlist trusted proxies before enabling automation.

Manual bans and policy settings are saved in configuration. Automatic bans and
activity counters reset on core restart. A manual ban closes existing NTRIP
connections within approximately one second and blocks new ones; it does not
block the admin HTTP interface. The IP page offers explicit unban and automatic
ban exemption controls. Deploy both the updated Rust binary and Node admin
server, then restart them to enable these features.


### Member accounts and rover self-service

Administrators allowlist members under **Users → Members** with a username and
unique email address. Only enabled, invited email addresses receive magic links;
there is no public registration. Existing members must have an email added before
they can sign in. Dashboard password login is replaced by email links; admin
HTTP Basic authentication and NTRIP credentials are unchanged.

Members enter their email at `/login` and open the emailed link to sign in
automatically. Links expire after 15 minutes and can be used once. A one-minute
per-member cooldown limits repeated sends while a link is pending. The response does not disclose
whether an email is invited. Links and sessions reset when Node restarts;
changing a member or disabling it revokes pending links and dashboard sessions.
Run a single Node instance (authentication state is in memory).

Set these production environment variables, then restart Node/Compose:

```dotenv
PUBLIC_HOSTNAME=rtk.k6sh.com
MAIL_FROM=NearTRIP <login@example.com>
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-smtp-username
SMTP_PASSWORD=your-smtp-password
NEARTRIP_SECURE_COOKIES=true
```

Sign-in links use `https://PUBLIC_HOSTNAME`, the same hostname used by Traefik.
SMTP defaults to port 465 with TLS enabled.

Port 587 uses required STARTTLS with `SMTP_SECURE=false`; port 465
uses TLS from connection start with `SMTP_SECURE=true`. Certificate
verification stays enabled. SMTP authentication is optional for a trusted relay
(omit both user and password). Use a sender address authorized by your mail
provider. The configured public URL is the canonical HTTPS origin used in
emails; request Host headers never determine sign-in links. Without SMTP host,
sender, or public URL, no emails are sent. Delivery failures are logged without
recipient addresses or tokens. Docker Compose forwards all variables above.

Members use **My rover credentials** (`/rovers`) to create up to ten credentials,
rotate generated passwords, enable/disable individual rovers, or delete unused
credentials. Deleting credentials revokes access and frees a slot in the ten-rover
limit; active streams disconnect on the next core policy check (about one second). Generated
passwords are displayed once. Ownership is assigned on the server.

Disabling a member immediately invalidates dashboard sessions and blocks their
rover credentials. Existing rover sockets close on the core's next policy check
(approximately one second after configuration reload). Re-enabling restores
credentials that remain individually enabled; the member must sign in again.
Once any member is configured, legacy shared/anonymous fallback is disabled;
existing standalone rover accounts remain valid but are not assigned to a member
automatically. Existing publishers are unaffected by member changes.

Dashboard sessions expire after eight hours and reset when Node restarts.
Magic-link requests have a 100-request per-client-IP budget per five minutes
when trusted proxies are configured, account backoff, and bounded send concurrency.
Member mutations
require a session CSRF token. Serve the dashboard through HTTPS. With TLS
terminating at a reverse proxy, set `NEARTRIP_SECURE_COOKIES=true` on Node to require secure
session cookies; forwarded identity/IP headers are not trusted automatically.

Behind Traefik or another reverse proxy, set `NEARTRIP_TRUSTED_PROXIES` to a
comma-separated list of the proxy's IP addresses or dedicated proxy-only CIDRs.
For example, `NEARTRIP_TRUSTED_PROXIES=172.30.0.2/32` trusts only that proxy.
Docker Compose passes this environment variable through to Node. Use the actual
address seen by Node; reserve a stable proxy address or a dedicated network.
Do not trust a shared network containing untrusted containers or all addresses.
The proxy must overwrite/sanitize incoming forwarding headers. Without this
setting (including an empty value), Node starts normally and ignores forwarded
addresses. It keeps account backoff and bounded password-check concurrency but
disables the five-minute IP block, because the TCP peer may represent every
member behind one proxy. Existing dashboard logins and the NTRIP listener keep
working without this variable. Configure trusted proxies to enable the additional
per-client IP failure budget. Changing this setting requires restarting Node.


Node observes disk configuration edits, atomic replacements, and symlink-target
replacements every 250 ms, invalidating affected member sessions. Configuration
reads also check for disk changes before returning data, preventing member
mutations from overwriting disk edits with stale account settings.
Unreadable or malformed configuration is rejected rather than replaced with defaults.

## Related Projects

[RusTK-caster](https://github.com/smerty/RusTK-caster) is a simple, robust way
to send NTRIP data without standing up a heavier stack such as RTKBase.
