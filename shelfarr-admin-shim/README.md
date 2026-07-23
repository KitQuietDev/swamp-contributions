# shelfarr-admin-shim

A small companion service for the
[`@kitquiet/shelfarr`](https://github.com/KitQuietDev/swamp-contributions/tree/main/shelfarr)
swamp extension. [Shelfarr](https://github.com/Pedro-Revez-Silva/shelfarr) has
no admin API for download clients, acquisition providers, or settings — only
session-cookie/CSRF-protected HTML forms. This shim exposes a narrow,
token-authenticated JSON API in front of Shelfarr's Rails console instead.

It is deliberately not generic. Each endpoint maps to exactly one fixed Rails
operation (`rails_ops/*.rb`). Caller-supplied values always travel as a JSON
file the script reads and parses — never interpolated into Ruby source as a
string — so this cannot be used to run arbitrary code inside the Shelfarr
container, only the three specific operations defined here.

## How it works

The shim runs `docker` itself (via a `docker-socket-proxy` sidecar, not a
direct socket mount) to `docker cp` a request's JSON payload and the relevant
`.rb` script into the Shelfarr container, then `docker exec`s `bin/rails
runner` against it, sourcing Shelfarr's own encryption keys so ActiveRecord's
encrypted attributes (API keys, passwords) work exactly as they would through
the Shelfarr UI.

## Security posture

- `docker-socket-proxy` is scoped to `CONTAINERS`, `EXEC`, and `POST` only —
  no image, network, volume, service, swarm, system, secrets, or node access.
- The proxy sits on an `internal: true` Docker network with zero outbound
  routing. It is never attached to any other network.
- The shim itself is dual-homed: the same internal network (to reach the
  proxy) plus a second, non-internal network used only so its port can be
  published to the host. The proxy never touches that second network.
- Every request requires an `X-Api-Key` header matching `SHIM_API_KEY`. The
  shim refuses to start if that variable isn't set.
- The shim's HTTP server binds `0.0.0.0` inside the container by design —
  Docker's port-forwarding delivers traffic via the container's bridge
  interface, not its own loopback. The actual host-only restriction lives in
  the compose `ports:` mapping (`127.0.0.1:8090:8090`), not the bind address.

## Deployment

1. Copy `.env.example` to `.env` and set a real `SHIM_API_KEY` (a long random
   value; never commit this file).
2. Adjust `SHELFARR_CONTAINER` in `docker-compose.yml` if your Shelfarr
   container isn't named `shelfarr`.
3. `docker compose up -d --build`
4. Confirm health: `curl -H "X-Api-Key: $SHIM_API_KEY" http://localhost:8090/health`

## Endpoints

- `GET /health` — liveness/auth check.
- `POST /download-clients` — upsert a download client.
- `POST /acquisition-providers` — upsert an acquisition provider.
- `PATCH /settings` — update one or more settings by key.

All require the `X-Api-Key` header. Request/response shapes match the
methods documented in the
[`@kitquiet/shelfarr`](https://github.com/KitQuietDev/swamp-contributions/tree/main/shelfarr)
extension.

## License

MIT — see LICENSE.txt for details.
