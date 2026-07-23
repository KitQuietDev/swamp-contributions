# @kitquiet/host-ports

A [swamp](https://github.com/swamp-club/swamp) extension model that catalogs TCP
ports currently listening on the local host — the machine swamp itself runs on,
not a remote target. Correlates each port with its owning process (via `ss`)
and, where applicable, the Docker container that published it (via `docker ps`).

Built after hitting `EADDRINUSE` wiring a new local service to a port that
turned out to already be owned by an unrelated system daemon. Query the last
snapshot before binding a new port instead of finding out the hard way.

Deliberately read-only: this extension only inspects sockets and containers, it
never binds, kills, or reconfigures anything.

**Scope**: IPv4 and IPv6 TCP listeners only. UDP is out of scope for this
version.

## Installation

```sh
swamp extension pull @kitquiet/host-ports
```

## Usage

No credentials required — this reads local host state only.

```sh
swamp model create @kitquiet/host-ports my-host-ports
swamp model method run my-host-ports list_listening_ports
```

Then query it before wiring a new service to a port:

```sh
swamp data query my-host-ports 'attributes.port == 9090'
```

## Configuration

```yaml
globalArguments:
  useSudo: false # set true to resolve pid/process for ports owned by other users
  includeDocker: true # set false on hosts without Docker installed
```

- **`useSudo`** — sockets owned by another user (e.g. root-owned `docker-proxy`,
  or a system daemon like Cockpit) don't expose their PID or process name to
  `ss` unless it runs as root. Setting this to `true` runs `sudo ss` instead of
  `ss`. Requires passwordless sudo for `ss` on this host — if sudo would prompt
  for a password, the command fails fast (stdin is closed) rather than hanging.
  Defaults to `false`: without it, `pid` and `process` are only populated for
  sockets owned by the user running swamp, but `port`/`address` are always
  populated regardless.
- **`includeDocker`** — correlates each listening port with `docker ps`
  published port mappings, filling in `dockerContainer`. Degrades gracefully
  (leaves `dockerContainer: null` on every entry) if Docker isn't installed or
  isn't reachable — this never fails the method. Set to `false` to skip the
  correlation entirely.

## Methods

- **`list_listening_ports`** — snapshots every TCP port currently listening on
  the host, storing one resource per port with:
  - `port`, `protocol` (`"tcp"`), `address` (bind address)
  - `pid`, `process` — `null` unless attributable (see `useSudo` above)
  - `dockerContainer` — the container name that published this port, or `null`
    if unpublished, non-Docker, or `includeDocker: false`

## How it works

Runs `ss -ltnp` to list listening TCP sockets, and (if `includeDocker` is
enabled) `docker ps --format '{{json .}}'` to correlate published port mappings
by host port number. Both invocations set `stdin: "null"` so a misconfigured
`sudo` can't hang the method waiting on a password prompt it will never receive
— it fails immediately with a descriptive error instead.

## License

MIT — see LICENSE.txt for details.
