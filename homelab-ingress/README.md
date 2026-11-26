# @kitquiet/homelab-ingress

A [swamp](https://github.com/swamp-club/swamp) extension for standing up a
self-hosted, tunnel-provider-free public ingress in front of a homelab:
WireGuard connecting a home network to a cheap public VPS, Traefik terminating
its own Let's Encrypt certificates there, Authelia gating everything behind
auth, and fail2ban banning scanners — with the host firewall reconciled
correctly so none of it silently breaks Docker networking.

Built from a real deployment, not a hypothetical one. Every model type here
encodes a bug that cost real debugging time getting a homelab edge onto a VPS
with no Cloudflare (or similar) tunnel in front of it — see
[How it works](#how-it-works) for specifics.

## Six model types, one topology

```
                 ┌─────────────────────┐
Internet ───────▶│  VPS (public IP)     │
                 │  docker_host_firewall│  ← nftables reconciliation
                 │  wireguard_tunnel    │  ← role: server
                 │  traefik_stack       │  ← ACME HTTP-01, no DNS API
                 │  authelia_gate       │  ← forward-auth (+ optional OIDC provider)
                 │  lldap_directory     │  ← optional shared user directory
                 │  fail2ban_jail       │  ← ban scanners
                 └──────────┬───────────┘
                            │ WireGuard tunnel
                 ┌──────────┴───────────┐
                 │  Homelab (home IP)    │
                 │  docker_host_firewall │  ← same reconciliation
                 │  wireguard_tunnel     │  ← role: client
                 │  (your actual apps)   │
                 └───────────────────────┘
```

`lldap_directory` is optional — `authelia_gate` defaults to managing its own
flat `users_database.yml` (`authBackend: "file"`), which is fine for a
single-admin setup. Once more than one person needs an account (each able to
change their own password without asking you to hand-edit YAML), deploy
`lldap_directory` alongside it and switch `authelia_gate` to
`authBackend: "ldap"` — see [6. `lldap_directory`](#6-lldap_directory) below.

Deploy `docker_host_firewall` + `wireguard_tunnel` (role: `server`) on the VPS
and `docker_host_firewall` + `wireguard_tunnel` (role: `client`) on the homelab
box first — everything else (Traefik, Authelia, fail2ban) runs on the VPS side
and proxies back over the tunnel to services on the homelab side.

## Prerequisites

- SSH access to both hosts, key-based, from wherever swamp runs methods.
- A public domain you control DNS for, pointed at the VPS's public IP.
- Docker + Docker Compose already installed on both hosts (these models deploy
  compose stacks and manage host-level firewall/services, but don't bootstrap
  Docker itself).
- A VPS with **no** existing DNS-provider-API-driven tunnel in front of it —
  this extension does its own ACME HTTP-01 challenge, which needs port 80/443
  reachable directly.

## Installation

```sh
swamp extension pull @kitquiet/homelab-ingress
```

## Secrets discipline

Every model type in this package shares the same `nodeHost`/`nodeUser`/
`nodePort`/`nodeIdentityFile`/`nodeIdentityContent`/`become*` SSH connection
fields (matching `@adam/cfgmgmt`'s convention). `nodeIdentityContent` and
`becomePassword` are marked sensitive — supply them as
`${{ vault.get(vault-name, key) }}` vault expressions, never literals.

Beyond that baseline, this package is deliberately careful about _other_ secrets
it generates or handles on your behalf:

- **WireGuard private keys** are generated on the target host itself, inside a
  single remote script. The script only ever echoes `GENERATED` or `EXISTING`
  back — the private key never transits through the machine running swamp.
- **Authelia's session/storage/JWT/OIDC-hmac secrets** are generated via
  `authelia crypto rand --file` inside a throwaway container, writing straight
  to files on the host — never printed, never returned as method output.
- **`authelia-gate`'s `add-user` method takes a password _hash_, not a plaintext
  password.** Run `authelia crypto hash generate argon2` yourself and pass the
  resulting hash — this extension will never ask for or handle a real password
  in plaintext. (Only relevant when `authBackend` is `"file"` — under
  `"ldap"`, identity lives in `lldap_directory` instead and this method
  refuses to run.)
- **`authelia-gate`'s OIDC issuer private key is the one deliberate exception**
  to "generated on-host, never round-tripped": Authelia's current schema
  requires the RSA key inline in YAML with no per-field secret mechanism, so
  generating it on-host would mean reading it back over the SSH exec channel.
  Instead `oidcIssuerPrivateKeyPem` is supplied by you via
  `${{ vault.get(vault, key) }}` — generate it yourself
  (`authelia crypto pair rsa generate`) and hand over only the PEM.
- **`authelia-gate`'s `add-oidc-client` method takes a client secret _digest_,
  not a plaintext secret** — same discipline as `add-user`'s password hash.
- **`lldap_directory`'s JWT secret, key seed, and admin bootstrap password**
  are generated on-host the same way as Authelia's secrets. `add-user`
  generates a fresh initial password on-host for new users and never returns
  it — only the on-host path it was written to, for you to retrieve once over
  SSH and hand to the person, who should change it immediately via LLDAP's
  own self-service profile page.

## Usage

### 1. `docker_host_firewall`

Run this first, on every host that runs both Docker and a custom
`nftables.conf`. Reconciles `forward` and `input` chain accept rules for
Docker's bridge interfaces, without ever doing a full ruleset reload (which
wipes Docker's own dynamic chains).

```sh
swamp model create @kitquiet/homelab-ingress/docker-host-firewall vps-firewall
```

```yaml
globalArguments:
  nodeHost: 203.0.113.10
  nodeUser: root
  nodeIdentityFile: ~/.ssh/id_ed25519
  dockerInterfaces: ["docker0", "br-*"]
```

```sh
swamp model method run vps-firewall check
swamp model method run vps-firewall apply
```

### 2. `wireguard_tunnel`

One instance per side of the tunnel.

```sh
swamp model create @kitquiet/homelab-ingress/wireguard-tunnel vps-wg
```

```yaml
globalArguments:
  nodeHost: 203.0.113.10
  nodeIdentityFile: ~/.ssh/id_ed25519
  role: server
  tunnelAddress: 198.51.100.1/24
  listenPort: 51820
  peerPublicKey: ${{ vault.get(homelab-vault, HOMELAB_WG_PUBKEY) }}
  peerAllowedIPs: 198.51.100.2/32
```

```sh
swamp model create @kitquiet/homelab-ingress/wireguard-tunnel homelab-wg
```

```yaml
globalArguments:
  nodeHost: 192.0.2.50
  nodeIdentityFile: ~/.ssh/id_ed25519
  role: client
  tunnelAddress: 198.51.100.2/24
  peerEndpoint: 203.0.113.10:51820
  peerPublicKey: ${{ vault.get(vps-vault, VPS_WG_PUBKEY) }}
  peerAllowedIPs: 198.51.100.1/32
  persistentKeepalive: 25
```

```sh
swamp model method run vps-wg apply
swamp model method run homelab-wg apply
swamp model method run vps-wg check
```

### 3. `traefik_stack`

Deploys on the VPS. ACME HTTP-01 only — no DNS-provider API dependency.

```sh
swamp model create @kitquiet/homelab-ingress/traefik-stack vps-traefik
```

```yaml
globalArguments:
  nodeHost: 203.0.113.10
  nodeIdentityFile: ~/.ssh/id_ed25519
  acmeEmail: you@example.com
  letsEncryptStaging: true # flip false once routes are verified working
```

```sh
swamp model method run vps-traefik apply
swamp model method run vps-traefik add-route --routerName immich \
  --hostname photos.example.com --backendUrl http://198.51.100.2:2283
```

### 4. `authelia_gate`

Also deploys on the VPS, paired with a `traefik_stack` instance (they must share
`networkName`, and `traefikDynamicConfigPath` must point at that instance's
dynamic config).

```sh
swamp model create @kitquiet/homelab-ingress/authelia-gate vps-authelia
```

**File-backed (default — fine for a single admin account):**

```yaml
globalArguments:
  nodeHost: 203.0.113.10
  nodeIdentityFile: ~/.ssh/id_ed25519
  traefikDynamicConfigPath: /opt/traefik-stack/dynamic.yml
  domain: example.com
  authHostname: auth.example.com
```

```sh
swamp model method run vps-authelia apply

# Native mobile apps can't follow the browser login redirect — bypass
# their status/API paths instead of gating them:
swamp model method run vps-authelia add-bypass-rule \
  --domain photos.example.com \
  --resources '["/api/.*"]'

swamp model method run vps-authelia add-user \
  --username jsmith \
  --passwordHash '$argon2id$v=19$...' \
  --email jsmith@example.com \
  --displayName "J Smith" \
  --groups '["admins"]'
```

**LDAP-backed (multiple people, each self-managing their own password — deploy
[`lldap_directory`](#6-lldap_directory) first):**

```yaml
globalArguments:
  nodeHost: 203.0.113.10
  nodeIdentityFile: ~/.ssh/id_ed25519
  traefikDynamicConfigPath: /opt/traefik-stack/dynamic.yml
  domain: example.com
  authHostname: auth.example.com
  authBackend: ldap
  ldapAddress: ldap://lldap:3890
  ldapBaseDn: dc=example,dc=com
  ldapBindUser: uid=admin,ou=people,dc=example,dc=com
  ldapBindPassword: ${{ vault.get(vps-vault, LLDAP_ADMIN_PASSWORD) }}
```

Under `authBackend: ldap`, add/manage people via
[`lldap_directory`'s `add-user`](#6-lldap_directory) instead —
`authelia-gate`'s own `add-user` refuses to run, since Authelia isn't
consulting `users_database.yml` at all in this mode.

**Optional: OIDC provider, for apps with native login (e.g. Immich,
Audiobookshelf) instead of a forward-auth redirect:**

```yaml
globalArguments:
  # ...as above, plus:
  oidcEnabled: true
  oidcIssuerPrivateKeyPem: ${{ vault.get(vps-vault, OIDC_ISSUER_KEY) }}
```

Generate the key yourself first — it's the one secret in this package not
generated on-host (see [Secrets discipline](#secrets-discipline) for why):

```sh
authelia crypto pair rsa generate -d . --file.private-key oidc_issuer_key.pem
```

```sh
swamp model method run vps-authelia apply

swamp model method run vps-authelia add-oidc-client \
  --clientId immich \
  --clientName Immich \
  --clientSecretHash '$pbkdf2-sha512$...' \
  --redirectUris '["https://photos.example.com/api/oauth/mobile-redirect", "https://photos.example.com/auth/login"]'
```

### 5. `fail2ban_jail`

```sh
swamp model create @kitquiet/homelab-ingress/fail2ban-jail vps-f2b-badbots
```

```yaml
globalArguments:
  nodeHost: 203.0.113.10
  nodeIdentityFile: ~/.ssh/id_ed25519
  jailName: traefik-badbots
  filterRegex: '^.*"ClientHost":"<HOST>".*"RequestPath":"(/\.env.*)".*$'
  logPath: /opt/traefik-stack/logs/access.log
```

```sh
swamp model method run vps-f2b-badbots apply
swamp model method run vps-f2b-badbots check
swamp model method run vps-f2b-badbots unban --ip 198.51.100.7
```

### 6. `lldap_directory`

Optional, deploys on the VPS alongside `authelia_gate` (must share
`networkName` so Authelia can reach it by container name). One shared user
directory instead of a per-app or per-Authelia-instance flat file — add a
person once here, done, instead of hand-editing `users_database.yml` (or
becoming everyone's password-reset support line).

```sh
swamp model create @kitquiet/homelab-ingress/lldap-directory vps-lldap
```

```yaml
globalArguments:
  nodeHost: 203.0.113.10
  nodeIdentityFile: ~/.ssh/id_ed25519
  ldapBaseDn: dc=example,dc=com
```

```sh
swamp model method run vps-lldap apply

swamp model method run vps-lldap add-user \
  --username jsmith \
  --email jsmith@example.com \
  --displayName "J Smith" \
  --groups '["admins"]'
```

`add-user` generates a fresh initial password on-host and never returns it —
only its on-host path (printed in the method's output resource). Retrieve it
once over SSH, hand it to the person, and have them change it immediately via
LLDAP's own web UI (`http://<nodeHost>:17170` if you choose to expose it, or
tunnel in — this extension doesn't publish LLDAP's ports by default). Point a
paired `authelia_gate` instance's `ldapAddress`/`ldapBaseDn`/`ldapBindUser`/
`ldapBindPassword` at this instance and set `authBackend: ldap` to actually
use it for login — see [4. `authelia_gate`](#4-authelia_gate) above.

Re-running `add-user` against an existing username updates their
displayName/email/groups but never resets their password — LLDAP's own
`bootstrap.sh` (which this method delegates to) only sets a password when one
is present in the user config, and this method omits it whenever the user
already exists.

## Methods

| Model type             | Methods                                                            |
| ---------------------- | -------------------------------------------------------------------|
| `docker-host-firewall` | `check`, `apply`                                                   |
| `wireguard-tunnel`     | `check`, `apply`, `rotate-key`                                     |
| `traefik-stack`        | `check`, `apply`, `add-route`, `remove-route`                      |
| `authelia-gate`        | `check`, `apply`, `add-bypass-rule`, `add-user`, `add-oidc-client`  |
| `lldap-directory`      | `check`, `apply`, `add-user`                                       |
| `fail2ban-jail`        | `check`, `apply`, `unban`                                          |

Every `apply` is idempotent against state _this extension itself created_ — safe
to re-run, converges to the desired state rather than blindly re-executing. See
[Adopting an existing deployment](#adopting-an-existing-deployment) below before
pointing `apply` at infrastructure that was configured some other way.

## Adopting an existing deployment

Verified against a real, already-running deployment (not built by this extension
— hand-configured over SSH): every `check` method correctly read live state
without touching anything — real compliant/non-compliant status, real WireGuard
handshake age, real fail2ban ban counts. `check` is safe to run against any
host, managed by this extension or not.

`apply`, however, assumes it fully owns the files it writes, and **does not
merge with configuration added some other way**. Two concrete risks this
surfaced:

- **`authelia_gate`'s `apply` regenerates `configuration.yml` from scratch.** If
  `access_control` rules were added by hand (or by an older version of the same
  Authelia deployment) rather than through this extension's `add-bypass-rule`,
  `apply` will silently drop them — it has no way to know they should be
  preserved. Before running `apply` against an existing Authelia instance,
  re-add every existing bypass rule via `add-bypass-rule` first, or expect to
  lose them on the first `apply`.
- **`fail2ban_jail` assumes one jail per file** at
  `/etc/fail2ban/jail.d/<jailName>.local`. A hand-built deployment that bundles
  multiple jails into one file (e.g. `/etc/fail2ban/jail.d/custom.local`) will
  report `non_compliant` even though the jail is genuinely active — `apply`
  would then create a second, competing file defining the same jail name, which
  fail2ban's behavior in that situation is not something to discover live. Point
  `jailName` only at hosts where this extension owns the jail files, or migrate
  the bundled file to the per-jail convention first.

`docker_host_firewall` and `wireguard_tunnel` don't have this problem — their
`apply` methods only ever add missing rules/lines rather than regenerating a
whole file, so they converge safely regardless of who set up the existing state.

- **Switching an existing `authelia_gate` instance from `authBackend: file`
  to `ldap` doesn't touch or delete `users_database.yml`** — it simply stops
  being read once Authelia's `authentication_backend` points at LDAP instead.
  Existing file-backend users need a corresponding `lldap_directory` account
  created via its own `add-user` before they can log in again; their old
  password hash can't be transplanted into LLDAP's own password storage
  (different hashing scheme entirely), so this is a fresh-password
  migration, not a hash copy.

## How it works

Three gotchas discovered the hard way, each directly encoded in this package
rather than left to be rediscovered:

- **A custom `nftables.conf` host needs _both_ its `forward` and `input` chains
  to explicitly accept the Docker bridge interfaces** (`docker0`/`br-*`), or
  Docker networking silently breaks in ways that look like application bugs.
  `docker_host_firewall`'s `check` reports each chain independently rather than
  assuming one implies the other.
- **Reloading such a host's firewall with `nft -f` outside of boot wipes
  Docker's own dynamically-managed chains.** `docker_host_firewall`'s `apply`
  only ever uses `nft insert rule` for live changes, never a full reload,
  specifically to avoid this.
- **fail2ban's `enable --now` is a no-op against an already-running service**
  and won't pick up a freshly-written jail. `fail2ban_jail`'s `apply` always
  explicitly `restart`s the service when config changes, then verifies the jail
  actually reports active afterward.
- **Native mobile apps can't follow Authelia's browser-redirect login flow.**
  iOS clients for Immich and Audiobookshelf (and similar apps) ping `/api/*` and
  specific status endpoints directly — `authelia_gate`'s `add-bypass-rule`
  exists specifically to pre-empt this instead of rediscovering it per app, and
  inserts new rules at the _front_ of `access_control` since Authelia evaluates
  rules top-to-bottom, first match wins.

Each model type carries its own SSH connection fields rather than sharing a
transport through another model — there is no supported cross-model
live-invocation API in swamp's extension runtime (`context.runModel()` does not
exist, despite being referenced in some registry descriptions). Connections are
pooled per `host:port:user` via SSH ControlMaster within a single process, so a
sequence of methods against the same host in one `swamp` invocation reuses one
connection.

## Known limitations

- **No teardown methods.** `docker_host_firewall`, `wireguard_tunnel`,
  `fail2ban_jail`, and `lldap_directory` have `check`/`apply` but nothing
  symmetric to remove what they added, and neither `authelia_gate`'s
  `add-bypass-rule`/`add-oidc-client` nor `lldap_directory`'s `add-user` have
  a `remove-*` counterpart — this package's scope is standing infrastructure
  up, not decommissioning it. Removing a rule/interface/jail/client/user
  currently means SSHing in (or using LLDAP's own web UI for users/groups) by
  hand.
- **No declared pre-flight checks.** Methods don't use swamp's separate `checks`
  mechanism (`--skip-check`/`--skip-check-label`) for things like "is this host
  reachable" ahead of a mutation — `connect()` failing with a descriptive error
  serves the same purpose today, just without the selective-skip ergonomics that
  mechanism provides.

## License

MIT — see LICENSE.txt for details.
