# @kitquiet/shelfarr

A [swamp](https://github.com/swamp-club/swamp) extension model for
[Shelfarr](https://github.com/Pedro-Revez-Silva/shelfarr), an audiobook/ebook
acquisition tool. Manages download clients, acquisition providers (indexer
sources), and settings.

Shelfarr has no admin API for this surface — only session-cookie/CSRF- protected
HTML forms. This extension does not scrape those forms or reach into the
container directly. Instead it talks to a small companion service,
[shelfarr-admin-shim](https://github.com/KitQuietDev/swamp-contributions/tree/main/shelfarr-admin-shim),
that exposes a narrow, token-authenticated JSON API in front of Shelfarr's Rails
console. The shim is deliberately not generic: each endpoint maps to one fixed
Rails operation, with caller-supplied values always passed as data and never
interpolated into code, so it cannot be used to run arbitrary commands inside
the Shelfarr container.

This means `baseUrl` in this extension points at the shim, not at Shelfarr
itself.

The API key is a `globalArguments` field, meant to be supplied as a swamp vault
expression (`${{ vault.get(vault-name, key) }}`) rather than a literal string.
Swamp resolves the expression at execution time inside its own runtime — the raw
key never has to pass through an agent's context, logs, or shell history to get
used. It is the shim's own key (`SHIM_API_KEY`), not any Shelfarr, Prowlarr, or
download-client key.

## Prerequisites

1. Deploy `shelfarr-admin-shim` alongside your Shelfarr container. See its own
   [README](https://github.com/KitQuietDev/swamp-contributions/tree/main/shelfarr-admin-shim)
   for the compose setup, including the `docker-socket-proxy` sidecar it
   requires (scoped to container exec/cp only, no image/network/volume/ system
   access) and the dual-homed network layout that keeps the socket proxy fully
   isolated while still publishing the shim's port to the host.
2. Generate a shim API key and store it in a vault.

## Installation

```sh
swamp extension pull @kitquiet/shelfarr
```

## Usage

Store the shim's API key in a vault, then create a model instance referencing
it:

```sh
swamp vault put my-vault SHELFARR_SHIM_API_KEY
swamp model create @kitquiet/shelfarr my-shelfarr
```

Edit the generated instance YAML:

```yaml
globalArguments:
  baseUrl: http://localhost:8090
  apiKey: ${{ vault.get(my-vault, SHELFARR_SHIM_API_KEY) }}
```

Then run a method:

```sh
swamp model method run my-shelfarr upsert_download_client \
  --input '{"name": "SABnzbd", "client_type": "sabnzbd", "url": "http://sabnzbd:8080", "api_key": "...", "priority": 0, "enabled": true}'
```

## Methods

- **`upsert_download_client`** — creates or updates a Shelfarr download client
  (idempotent, matches by name). Supports qBittorrent, Decypharr, SABnzbd,
  NZBGet, Deluge, and Transmission.
- **`upsert_acquisition_provider`** — creates or updates a Shelfarr acquisition
  provider / indexer source (idempotent, matches by name), e.g. Prowlarr.
- **`update_settings`** — updates one or more Shelfarr settings by key, e.g.
  `download_remote_path`.

All three require the `shim-reachable` check to pass first, which confirms the
shim is up and the API key authenticates before attempting the underlying Rails
operation.

## How it works

Every method sends the `X-Api-Key` header against `globalArguments.baseUrl` (the
shim, not Shelfarr). The shim writes the request body to a JSON file, copies it
plus a static, pre-written Rails runner script into the Shelfarr container via
`docker cp`, then executes it via `docker exec ... bin/rails
runner`, sourcing
Shelfarr's own encryption keys so ActiveRecord's encrypted attributes (API keys,
passwords) work exactly as they would through the Shelfarr UI itself.

## License

MIT — see LICENSE.txt for details.
