# @kitquiet/prowlarr

A [swamp](https://github.com/swamp-club/swamp) extension model for
[Prowlarr](https://prowlarr.com/), the indexer manager used by the \*arr
media-automation ecosystem (Sonarr, Radarr, Readarr, and similar tools). It
wraps Prowlarr's REST API so an agent or workflow can list, add, update, sync,
and remove indexers — including Torznab-compatible sources proxied through
Jackett — without ever touching Prowlarr's API key directly.

The API key is a `globalArguments` field, meant to be supplied as a swamp vault
expression (`${{ vault.get(vault-name, key) }}`) rather than a literal string.
Swamp resolves the expression at execution time inside its own runtime — the raw
key never has to pass through an agent's context, logs, or shell history to get
used.

## Installation

```sh
swamp extension pull @kitquiet/prowlarr
```

## Usage

Store the API key in a vault, then create a model instance referencing it:

```sh
echo "$PROWLARR_API_KEY" | swamp vault put my-vault PROWLARR_API_KEY
swamp model create @kitquiet/prowlarr my-prowlarr
```

Edit the generated instance YAML:

```yaml
globalArguments:
  baseUrl: http://localhost:9696
  apiKey: ${{ vault.get(my-vault, PROWLARR_API_KEY) }}
```

Then run a method:

```sh
swamp model method run my-prowlarr list_indexers
```

```sh
swamp model method run my-prowlarr add_torznab_indexer \
  --input 'name=Jackett - AudiobookBay' \
  --input 'siteBaseUrl=http://jackett:9117' \
  --input 'apiPath=/api/v2.0/indexers/audiobookbay/results/torznab' \
  --input "siteApiKey=\${{ vault.get(my-vault, JACKETT_API_KEY) }}"
```

## Methods

- **`list_indexers`** — fetches every configured indexer from Prowlarr and
  stores each as an `indexer` resource (`indexer-<id>`).
- **`add_torznab_indexer`** — fetches Prowlarr's own "Generic Torznab" schema
  template, fills in the target site's base URL, API path, and API key, and
  creates the indexer. This is the exact flow used to wire a Jackett-proxied
  source (e.g. AudiobookBay) into Prowlarr's aggregate search — normally a
  manual multi-step UI process.
- **`update_indexer`** — reads an indexer's current live state, merges in any of
  `enable` / `priority` / `appProfileId` that were passed, and PUTs the result
  back. Untouched fields are preserved as-is.
- **`sync_indexer`** — refreshes a single indexer's stored resource from live
  Prowlarr state. If the indexer no longer exists, writes a
  `status: "not_found"` marker instead of throwing, for drift detection.
- **`remove_indexer`** — deletes an indexer from Prowlarr by ID and cleans up
  the corresponding stored resource. Treats "already gone" (404) as success
  rather than an error.

`add_torznab_indexer` is idempotent: if an indexer with the same `name` already
exists, it returns that indexer instead of creating a duplicate — safe to retry
after a partial failure.

A pre-flight check (`prowlarr-reachable`, labeled `live`) runs automatically
before `add_torznab_indexer`, `update_indexer`, and `remove_indexer`, confirming
Prowlarr is reachable and the API key authenticates before any mutation is
attempted. Skip it with `--skip-check-label live` if needed.

## How it works

Every method authenticates with the `X-Api-Key` header against
`globalArguments.baseUrl`. No other prerequisites — just a reachable Prowlarr
instance and its API key in a vault. API responses are validated against the
expected schema (via Zod) before use, so a malformed or unexpected Prowlarr
response fails with a clear message rather than a raw type error.
`add_torznab_indexer` makes two calls beyond the existence check: a
`GET /api/v1/indexer/schema` to fetch the current template (so field
ordering/shape changes upstream don't break this extension), then a
`POST /api/v1/indexer` with the filled-in template. Prowlarr performs a live
connectivity check against the target site synchronously — the method fails fast
if the target site is unreachable or misconfigured.

## License

MIT — see LICENSE.txt for details.
