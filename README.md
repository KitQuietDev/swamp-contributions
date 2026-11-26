# swamp-contributions

Extensions for [swamp](https://github.com/swamp-club/swamp) that I wrote because my homelab needed them. Most of them started as "I'm tired of clicking through this web UI" and ended up as typed, testable models I can run from a workflow.

They're all published under `@kitquiet` on the swamp registry, MIT licensed, and the code here is what's running against my own media stack and edge server. I'm putting them up in case any of it saves someone else the same afternoon.

## What's in here

| Extension | What it does |
| --- | --- |
| [`gluetun`](gluetun) | Read-only look at a [gluetun](https://github.com/qdm12/gluetun) VPN container: is it up, and what's the public IP. Uses the status endpoint that works on WireGuard, not the OpenVPN-only one that lies to you. |
| [`prowlarr`](prowlarr) | List, add (Torznab) and remove [Prowlarr](https://prowlarr.com) indexers over its API. |
| [`qbittorrent`](qbittorrent) | Categories, adding torrents by magnet or URL, listing, and a connection check for [qBittorrent](https://www.qbittorrent.org). Handles the session-cookie login for you. |
| [`sabnzbd`](sabnzbd) | Categories, queue and history, and sending an NZB by URL to [SABnzbd](https://sabnzbd.net). |
| [`shelfarr`](shelfarr) | Configure [Shelfarr](https://github.com/Pedro-Revez-Silva/shelfarr) download clients, providers and settings. Shelfarr has no admin API, so this talks to the companion shim below. |
| [`shelfarr-admin-shim`](shelfarr-admin-shim) | The small service that makes the Shelfarr extension possible. A locked-down JSON API in front of Shelfarr's Rails console, with a fixed set of operations. Not a swamp extension itself. |
| [`host-ports`](host-ports) | Which TCP ports are listening on a host, which process owns each, and which Docker container published it. Handy before you bind something new. |
| [`homelab-ingress`](homelab-ingress) | The big one. Runs a public edge for a homelab without a tunnel provider: nftables and Docker firewall reconciliation, WireGuard, Traefik with its own Let's Encrypt certs, Authelia, LLDAP and fail2ban. |

## Using one

```sh
swamp extension pull @kitquiet/gluetun
swamp vault put my-vault GLUETUN_API_KEY      # prompts for the value
swamp model create @kitquiet/gluetun my-gluetun
swamp model method run my-gluetun get_vpn_status
```

You point the model at your own service by setting its global arguments (a base URL and, where one is needed, an API key) in the model definition.

Each folder has its own README with the real arguments and examples.

## Secrets

None of these want a literal API key or password on the command line. Anything sensitive is resolved from a swamp vault when the method runs:

```yaml
globalArguments:
  baseUrl: http://sabnzbd:8080
  apiKey: ${{ vault.get(my-vault, SABNZBD_API_KEY) }}
```

## A few honest notes

- These came out of one specific setup. If your network looks different, expect to read the code. Where I hit a gotcha that cost me real time (Docker's firewall chains getting wiped by an `nft` reload, for one) it's written down in the extension's README instead of hiding in a commit message.
- The ingress extension in particular manages a firewall and an auth gate over SSH. Try it on something you can afford to lock yourself out of first.
- Each extension has unit tests (`*_test.ts`) that run without touching a real service. They mock the HTTP and shell calls, so they say nothing about whether your gluetun is configured the way mine is.

## Developing

You'll need swamp and its bundled Deno:

```sh
deno test -A gluetun/          # run one extension's tests
swamp extension quality gluetun/manifest.yaml
```

Version numbers are CalVer (`YYYY.MM.DD.N`), bumped whenever a package's content changes.

## License

MIT. Each folder carries its own `LICENSE.txt`.
