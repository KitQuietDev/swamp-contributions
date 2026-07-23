# @kitquiet/gluetun

A [swamp](https://github.com/swamp-club/swamp) extension model for
[gluetun](https://github.com/qdm12/gluetun), the VPN client container
commonly used to route \*arr-stack download clients (qBittorrent, SABnzbd,
etc.) through a VPN tunnel. It wraps gluetun's HTTP control server for
read-only VPN status and public IP visibility.

Deliberately read-only: gluetun's control API can also change VPN state and
port forwarding, but this extension only exposes status/visibility methods,
matching a narrowly-scoped API key role rather than a broad one.

The API key is a `globalArguments` field, meant to be supplied as a swamp
vault expression (`${{ vault.get(vault-name, key) }}`) rather than a literal
string. Swamp resolves the expression at execution time inside its own
runtime — the raw key never has to pass through an agent's context, logs, or
shell history to get used.

## Prerequisites

gluetun's control server has **no authentication enabled by default** — it
logs a startup warning about this. Before using this extension:

1. Create an auth config at `/gluetun/auth/config.toml` inside the
   container (or wherever `HTTP_CONTROL_SERVER_AUTH_CONFIG_FILEPATH`
   points), scoped to just the routes this extension needs:

   ```toml
   [[roles]]
   name = "swamp-extension"
   routes = ["GET /v1/vpn/status", "GET /v1/publicip/ip"]
   auth = "apikey"
   apikey = "your-generated-key-here"
   ```

2. gluetun's control server is often **not published to the host** by
   default (only the proxied application ports usually are). Add a
   `ports:` entry for it in your compose file if you need to reach it
   from outside gluetun's own Docker network — e.g. `"8001:8000"` (pick a
   free host port; `8000` is a common collision with other self-hosted
   tools).

See the full docs at the
[gluetun-wiki control server authentication page](https://github.com/qdm12/gluetun-wiki/blob/main/setup/advanced/control-server.md#authentication).

## Installation

```sh
swamp extension pull @kitquiet/gluetun
```

## Usage

Store the API key in a vault, then create a model instance referencing it:

```sh
swamp vault put my-vault GLUETUN_API_KEY
swamp model create @kitquiet/gluetun my-gluetun
```

Edit the generated instance YAML:

```yaml
globalArguments:
  baseUrl: http://localhost:8001
  apiKey: ${{ vault.get(my-vault, GLUETUN_API_KEY) }}
```

Then run a method:

```sh
swamp model method run my-gluetun get_vpn_status
```

```sh
swamp model method run my-gluetun get_public_ip
```

## Methods

- **`get_vpn_status`** — fetches gluetun's protocol-agnostic VPN status
  (`running`/`stopped`) from `/v1/vpn/status`.
- **`get_public_ip`** — fetches the public IP address (plus country/city/
  region/organization, when available) as seen through the VPN tunnel,
  from `/v1/publicip/ip`.

## How it works

Every method authenticates with the `X-Api-Key` header against
`globalArguments.baseUrl`. **Deliberately uses `/v1/vpn/status`, not
`/v1/openvpn/status`** — gluetun exposes both, but the OpenVPN-specific
endpoint reports `"stopped"` even when the tunnel is genuinely up on a
WireGuard-based setup (confirmed against a real WireGuard instance). The
protocol-agnostic endpoint is correct regardless of which VPN protocol
gluetun is actually configured to use.

## License

MIT — see LICENSE.txt for details.
