# @kitquiet/sabnzbd

A [swamp](https://github.com/swamp-club/swamp) extension model for
[SABnzbd](https://sabnzbd.org/), the Usenet download client used across the
\*arr media-automation ecosystem. It wraps SABnzbd's REST API for category
management, queue/history visibility, and NZB-by-URL submission, without
ever handling the API key directly.

The API key is a `globalArguments` field, meant to be supplied as a swamp
vault expression (`${{ vault.get(vault-name, key) }}`) rather than a literal
string. Swamp resolves the expression at execution time inside its own
runtime — the raw key never has to pass through an agent's context, logs, or
shell history to get used.

## Installation

```sh
swamp extension pull @kitquiet/sabnzbd
```

## Usage

Store the API key in a vault, then create a model instance referencing it:

```sh
echo "$SABNZBD_API_KEY" | swamp vault put my-vault SABNZBD_API_KEY
swamp model create @kitquiet/sabnzbd my-sabnzbd
```

Edit the generated instance YAML:

```yaml
globalArguments:
  baseUrl: http://localhost:8080
  apiKey: ${{ vault.get(my-vault, SABNZBD_API_KEY) }}
```

Then run a method:

```sh
swamp model method run my-sabnzbd list_categories
```

```sh
swamp model method run my-sabnzbd add_category \
  --input 'name=audiobooks' \
  --input 'priority=0'
```

## Methods

- **`list_categories`** — fetches every configured category (excluding the
  built-in `*` default) and stores each as a `category` resource.
- **`add_category`** — creates a category. Idempotent: if one with the same
  name already exists, returns it instead of erroring or duplicating.
- **`remove_category`** — deletes a category by name. Treats "already gone"
  as success rather than an error.
- **`get_queue`** — snapshots the current download queue (speed, slots,
  disk space).
- **`get_history`** — fetches recent completed/failed history entries,
  each stored keyed by SABnzbd's own `nzo_id`.
- **`add_nzb_url`** — adds an NZB to the queue by URL, with optional
  display name and category.

## How it works

Every method authenticates via an `apikey` query parameter against
`globalArguments.baseUrl`. One deliberate detail worth knowing: SABnzbd's
API always lives at `/api`, never `/<url_base>/api` — a reverse-proxy path
prefix does not apply to the API endpoint, only the web UI.

SABnzbd doesn't always use HTTP status codes to signal API-level failures —
some errors come back as HTTP 200 with an `{"error": "..."}` body (for
example, a wrong API key returns a real 403 in some cases but not always).
This extension checks the response body for an `error` key on every call,
not just `response.ok`, so failures surface with a real error message
either way.

## License

MIT — see LICENSE.txt for details.
