# @kitquiet/qbittorrent

A [swamp](https://github.com/swamp-club/swamp) extension model for
[qBittorrent](https://www.qbittorrent.org/), the torrent client used across
the \*arr media-automation ecosystem. It wraps qBittorrent's WebUI API (v2)
for category management and connection verification, handling qBittorrent's
session-cookie login internally so callers never touch it directly.

Unlike most \*arr-family services, qBittorrent authenticates with a
username/password login that issues a short-lived session cookie (`SID`),
not a static API key. Every method here logs in fresh and discards the
session afterward rather than trying to persist one across separate method
invocations. Both credentials are `globalArguments` fields, meant to be
supplied as swamp vault expressions (`${{ vault.get(vault-name, key) }}`)
rather than literal values — swamp resolves the expression at execution
time inside its own runtime, so the raw values never have to pass through
an agent's context, logs, or shell history to get used.

## Installation

```sh
swamp extension pull @kitquiet/qbittorrent
```

## Usage

Store both credentials in a vault, then create a model instance referencing
them:

```sh
swamp vault put my-vault QBITTORRENT_PASSWORD
swamp model create @kitquiet/qbittorrent my-qbittorrent
```

Edit the generated instance YAML:

```yaml
globalArguments:
  baseUrl: http://localhost:8080
  username: qbAdmin
  password: ${{ vault.get(my-vault, QBITTORRENT_PASSWORD) }}
```

Then run a method:

```sh
swamp model method run my-qbittorrent test_connection
```

```sh
swamp model method run my-qbittorrent add_category \
  --input 'name=audiobooks' \
  --input 'savePath=/downloads/audiobooks'
```

## Methods

- **`test_connection`** — attempts a login and reports whether it
  succeeded, without making any other change. Never throws on bad
  credentials; the result is the point.
- **`list_categories`** — fetches every configured category and stores
  each as a `category` resource.
- **`add_category`** — creates a category. Idempotent: if one with the
  same name already exists, returns it instead of erroring or duplicating.
- **`remove_category`** — deletes a category by name.

## How it works

Every method calls qBittorrent's `/api/v2/auth/login` first, extracts the
`SID` cookie from the response, and includes it on the actual API call.
qBittorrent signals a failed login via response body text (`"Fails."`)
with an HTTP 200, not a non-2xx status — the body is checked, not just
`response.ok`.

**Worth knowing if you're debugging a failed login**: qBittorrent bans an
IP for one hour after 5 failed attempts within a short window. If
`test_connection` reports `connected: false` unexpectedly, check the
credentials directly against the WebUI once rather than retrying this
method repeatedly — each retry with bad credentials counts toward that
same ban counter.

qBittorrent commonly shares its VPN container's network namespace (a
`network_mode: service:gluetun`-style setup) rather than having its own
container hostname — if `baseUrl` pointed at qBittorrent's own name
doesn't resolve, try the VPN container's name/published port instead.

## License

MIT — see LICENSE.txt for details.
