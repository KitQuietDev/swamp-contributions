/**
 * Manages one side of a WireGuard tunnel (role: server or client) via SSH.
 * Models the exact discipline used building a real homelab-to-VPS tunnel:
 * the private key is generated *on the target host* and never leaves it —
 * every remote script here is written so the private key value never
 * appears in anything captured back over the SSH exec channel (config-file
 * existence and specific expected lines are checked via grep exit codes,
 * never by catting the whole file, since the file contains the key).
 *
 * Two model instances (one `role: "server"`, one `role: "client"`) make a
 * tunnel — each one's `apply` output includes its own public key, meant to
 * be handed to the other instance's `peerPublicKey` field.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { execSudo, getConnection, shellEscape } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  nodeHost: z.string().describe("Hostname or IP of the target node"),
  nodeUser: z.string().default("root").describe("SSH username"),
  nodePort: z.number().default(22).describe("SSH port"),
  nodeIdentityFile: z.string().optional().describe(
    "Path to an SSH private key file on the machine running this method",
  ),
  nodeIdentityContent: z.string().optional().meta({ sensitive: true })
    .describe(
      "PEM private key content — supply via ${{ vault.get(vault, key) }}",
    ),
  become: z.boolean().default(false).describe(
    "Enable sudo privilege escalation (leave false if nodeUser is already root)",
  ),
  becomeUser: z.string().default("root").describe("User to become via sudo"),
  becomePassword: z.string().optional().meta({ sensitive: true }).describe(
    "Password for sudo -S, via ${{ vault.get(vault, key) }}",
  ),
  interfaceName: z.string().default("wg0").describe("WireGuard interface name"),
  role: z.enum(["server", "client"]).describe(
    "server listens on listenPort; client dials peerEndpoint",
  ),
  tunnelAddress: z.string().describe(
    "This side's address within the tunnel, CIDR — e.g. 198.51.100.1/24",
  ),
  listenPort: z.number().optional().describe(
    "UDP port to listen on — required for role: server",
  ),
  peerPublicKey: z.string().describe("The other side's WireGuard public key"),
  peerEndpoint: z.string().optional().describe(
    "host:port to reach the peer — required for role: client",
  ),
  peerAllowedIPs: z.string().describe(
    "CIDR(s) routed through this peer, e.g. 198.51.100.2/32",
  ),
  persistentKeepalive: z.number().optional().describe(
    "Seconds between keepalive packets — set on the side behind NAT (typically the client)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

interface MethodContext {
  globalArgs: GlobalArgs;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

function sudoOpts(g: GlobalArgs) {
  return {
    become: g.become,
    becomeUser: g.becomeUser,
    becomePassword: g.becomePassword,
  };
}

const StateSchema = z.object({
  host: z.string(),
  interfaceName: z.string(),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]),
  up: z.boolean(),
  publicKey: z.string().nullable(),
  listenPort: z.number().nullable(),
  lastHandshakeAgeSeconds: z.number().nullable(),
  changes: z.array(z.string()),
  error: z.string().nullable(),
  timestamp: z.string(),
});

function connect(g: GlobalArgs) {
  return getConnection({
    host: g.nodeHost,
    port: g.nodePort,
    username: g.nodeUser,
    privateKeyPath: g.nodeIdentityFile,
    identityContent: g.nodeIdentityContent,
  });
}

function confPath(g: GlobalArgs): string {
  return `/etc/wireguard/${g.interfaceName}.conf`;
}

function privateKeyPath(g: GlobalArgs): string {
  return `/etc/wireguard/${g.interfaceName}_privatekey`;
}

function publicKeyPath(g: GlobalArgs): string {
  return `/etc/wireguard/${g.interfaceName}_publickey`;
}

/** Non-secret config lines this instance expects to find in the conf file — never includes PrivateKey. */
export function expectedLines(g: GlobalArgs): string[] {
  const lines = [
    `Address = ${g.tunnelAddress}`,
    `PublicKey = ${g.peerPublicKey}`,
    `AllowedIPs = ${g.peerAllowedIPs}`,
  ];
  if (g.role === "server" && g.listenPort) {
    lines.push(`ListenPort = ${g.listenPort}`);
  }
  if (g.role === "client" && g.peerEndpoint) {
    lines.push(`Endpoint = ${g.peerEndpoint}`);
  }
  if (g.persistentKeepalive) {
    lines.push(`PersistentKeepalive = ${g.persistentKeepalive}`);
  }
  return lines;
}

interface WgShowParsed {
  up: boolean;
  publicKey: string | null;
  listenPort: number | null;
  lastHandshakeAgeSeconds: number | null;
}

/** Parses `wg show <interface>` text output into up/publicKey/listenPort/handshake-age fields. */
export function parseWgShow(output: string): WgShowParsed {
  if (!output.trim()) {
    return {
      up: false,
      publicKey: null,
      listenPort: null,
      lastHandshakeAgeSeconds: null,
    };
  }
  const pubMatch = output.match(/public key:\s*(\S+)/);
  const portMatch = output.match(/listening port:\s*(\d+)/);
  const handshakeMatch = output.match(/latest handshake:\s*(.+)/);
  let lastHandshakeAgeSeconds: number | null = null;
  if (handshakeMatch) {
    const text = handshakeMatch[1].trim();
    // wg show reports relative time like "52 seconds ago", "3 minutes, 10 seconds ago", or "Now"
    if (/^now$/i.test(text)) {
      lastHandshakeAgeSeconds = 0;
    } else {
      let seconds = 0;
      const minute = text.match(/(\d+)\s*minute/);
      const second = text.match(/(\d+)\s*second/);
      const hour = text.match(/(\d+)\s*hour/);
      const day = text.match(/(\d+)\s*day/);
      if (day) seconds += parseInt(day[1]) * 86400;
      if (hour) seconds += parseInt(hour[1]) * 3600;
      if (minute) seconds += parseInt(minute[1]) * 60;
      if (second) seconds += parseInt(second[1]);
      lastHandshakeAgeSeconds = seconds;
    }
  }
  return {
    up: true,
    publicKey: pubMatch ? pubMatch[1] : null,
    listenPort: portMatch ? parseInt(portMatch[1]) : null,
    lastHandshakeAgeSeconds,
  };
}

async function gather(
  client: Awaited<ReturnType<typeof connect>>,
  g: GlobalArgs,
) {
  const so = sudoOpts(g);
  const showResult = await execSudo(
    client,
    `wg show ${shellEscape(g.interfaceName)} 2>&1`,
    so,
  );
  const parsed = parseWgShow(
    showResult.exitCode === 0 ? showResult.stdout : "",
  );

  const existsResult = await execSudo(
    client,
    `test -f ${shellEscape(confPath(g))} && echo EXISTS || echo MISSING`,
    so,
  );
  const confExists = existsResult.stdout.trim() === "EXISTS";

  const missingLines: string[] = [];
  if (confExists) {
    for (const line of expectedLines(g)) {
      const check = await execSudo(
        client,
        `grep -qF ${shellEscape(line)} ${
          shellEscape(confPath(g))
        } && echo OK || echo MISSING`,
        so,
      );
      if (check.stdout.trim() !== "OK") missingLines.push(line);
    }
  }

  return { parsed, confExists, missingLines };
}

/** Manages one side (`role: server` or `client`) of a WireGuard tunnel via SSH; the private key never leaves the target host. See `check`/`apply`/`rotate-key` methods below. */
export const model = {
  type: "@kitquiet/homelab-ingress/wireguard-tunnel",
  version: "2026.07.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description: "Result of check or apply operation",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description:
        "Check interface/config state and peer handshake freshness (dry-run)",
      arguments: z.object({}),
      execute: async (_args: unknown, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info(
          "Checking wireguard interface {interfaceName} on {host}",
          { interfaceName: g.interfaceName, host: g.nodeHost },
        );
        try {
          const client = await connect(g);
          const { parsed, confExists, missingLines } = await gather(client, g);
          const changes: string[] = [];
          if (!confExists) changes.push("create config file");
          for (const line of missingLines) changes.push(`add line: ${line}`);
          if (!parsed.up) changes.push("bring interface up");

          const handle = await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            interfaceName: g.interfaceName,
            status: changes.length === 0 ? "compliant" : "non_compliant",
            up: parsed.up,
            publicKey: parsed.publicKey,
            listenPort: parsed.listenPort,
            lastHandshakeAgeSeconds: parsed.lastHandshakeAgeSeconds,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          context.logger.info(
            "{interfaceName} on {host} is {status}",
            {
              interfaceName: g.interfaceName,
              host: g.nodeHost,
              status: changes.length === 0 ? "compliant" : "non_compliant",
            },
          );
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            interfaceName: g.interfaceName,
            status: "failed",
            up: false,
            publicKey: null,
            listenPort: null,
            lastHandshakeAgeSeconds: null,
            changes: [],
            error: (err as Error).message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
    apply: {
      description:
        "Install WireGuard if missing, generate a keypair on the target host if none exists (never returned as plaintext), write the config, and bring the interface up",
      arguments: z.object({}),
      execute: async (_args: unknown, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info(
          "Applying wireguard interface {interfaceName} on {host} (role: {role})",
          { interfaceName: g.interfaceName, host: g.nodeHost, role: g.role },
        );
        try {
          const client = await connect(g);
          const so = sudoOpts(g);
          const changes: string[] = [];

          const installCheck = await execSudo(client, "which wg wg-quick", so);
          if (installCheck.exitCode !== 0) {
            const install = await execSudo(
              client,
              "apt-get update -qq && apt-get install -y -qq wireguard",
              so,
            );
            if (install.exitCode !== 0) {
              throw new Error(`wireguard install failed: ${install.stderr}`);
            }
            changes.push("installed wireguard package");
          }

          // Generate a keypair on the target host if none exists yet — only
          // the public key is ever echoed back over this exec channel.
          const keygenScript = [
            "set -e",
            "mkdir -p /etc/wireguard",
            `if [ ! -f ${shellEscape(privateKeyPath(g))} ]; then`,
            "  umask 077",
            `  wg genkey | tee ${
              shellEscape(privateKeyPath(g))
            } | wg pubkey > ${shellEscape(publicKeyPath(g))}`,
            "  echo GENERATED",
            "else",
            "  echo EXISTING",
            "fi",
          ].join("\n");
          const keygen = await execSudo(client, keygenScript, so);
          if (keygen.exitCode !== 0) {
            throw new Error(`keypair generation failed: ${keygen.stderr}`);
          }
          if (keygen.stdout.includes("GENERATED")) {
            changes.push(
              "generated new keypair (private key never left the host)",
            );
          }

          const pubkeyResult = await execSudo(
            client,
            `cat ${shellEscape(publicKeyPath(g))}`,
            so,
          );
          const publicKey = pubkeyResult.stdout.trim();

          const { confExists, missingLines } = await gather(client, g);
          const needsWrite = !confExists || missingLines.length > 0;

          if (needsWrite) {
            const lines = [
              "[Interface]",
              `Address = ${g.tunnelAddress}`,
            ];
            if (g.role === "server" && g.listenPort) {
              lines.push(`ListenPort = ${g.listenPort}`);
            }
            lines.push(
              "PrivateKey = $PRIV",
              "",
              "[Peer]",
              `PublicKey = ${g.peerPublicKey}`,
            );
            if (g.role === "client" && g.peerEndpoint) {
              lines.push(`Endpoint = ${g.peerEndpoint}`);
            }
            lines.push(`AllowedIPs = ${g.peerAllowedIPs}`);
            if (g.persistentKeepalive) {
              lines.push(`PersistentKeepalive = ${g.persistentKeepalive}`);
            }
            // PrivateKey is substituted from the on-host file entirely within
            // this one remote script — its value never transits back to us.
            const writeScript = [
              "set -e",
              `PRIV=$(cat ${shellEscape(privateKeyPath(g))})`,
              `cat > ${shellEscape(confPath(g))} <<'WGEOF'\n${
                lines.join("\n")
              }\nWGEOF`,
              `sed -i "s#\\$PRIV#$PRIV#" ${shellEscape(confPath(g))}`,
              `chmod 600 ${shellEscape(confPath(g))}`,
              "echo WRITTEN",
            ].join("\n");
            const write = await execSudo(client, writeScript, so);
            if (write.exitCode !== 0) {
              throw new Error(`config write failed: ${write.stderr}`);
            }
            changes.push(
              confExists ? "updated config file" : "created config file",
            );
          }

          const enableResult = await execSudo(
            client,
            `systemctl enable --now wg-quick@${shellEscape(g.interfaceName)}`,
            so,
          );
          if (enableResult.exitCode !== 0) {
            throw new Error(
              `interface enable/start failed: ${enableResult.stderr}`,
            );
          }
          if (!changes.includes("created config file") && needsWrite) {
            // `enable --now` only starts a not-yet-running interface — an
            // already-running one needs an explicit restart to pick up a
            // config change.
            const restart = await execSudo(
              client,
              `systemctl restart wg-quick@${shellEscape(g.interfaceName)}`,
              so,
            );
            if (restart.exitCode !== 0) {
              throw new Error(`interface restart failed: ${restart.stderr}`);
            }
            changes.push("restarted interface to apply config change");
          }

          const final = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            interfaceName: g.interfaceName,
            status: changes.length === 0 ? "compliant" : "applied",
            up: final.parsed.up,
            publicKey: final.parsed.publicKey ?? publicKey,
            listenPort: final.parsed.listenPort,
            lastHandshakeAgeSeconds: final.parsed.lastHandshakeAgeSeconds,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          context.logger.info(
            "Applied {count} change(s) to {interfaceName} on {host}",
            {
              count: changes.length,
              interfaceName: g.interfaceName,
              host: g.nodeHost,
            },
          );
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            interfaceName: g.interfaceName,
            status: "failed",
            up: false,
            publicKey: null,
            listenPort: null,
            lastHandshakeAgeSeconds: null,
            changes: [],
            error: (err as Error).message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
    "rotate-key": {
      description:
        "Generate a new keypair on the target host (does not propagate to the peer — hand the returned public key to the other side's apply call yourself)",
      arguments: z.object({}),
      execute: async (_args: unknown, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info(
          "Rotating wireguard keypair for {interfaceName} on {host}",
          { interfaceName: g.interfaceName, host: g.nodeHost },
        );
        try {
          const client = await connect(g);
          const so = sudoOpts(g);
          const script = [
            "set -e",
            `[ -f ${shellEscape(privateKeyPath(g))} ] && mv ${
              shellEscape(privateKeyPath(g))
            } ${shellEscape(privateKeyPath(g))}.bak-$(date +%s) || true`,
            "umask 077",
            `wg genkey | tee ${shellEscape(privateKeyPath(g))} | wg pubkey > ${
              shellEscape(publicKeyPath(g))
            }`,
            `PRIV=$(cat ${shellEscape(privateKeyPath(g))})`,
            `sed -i "/^PrivateKey = /c\\\\PrivateKey = $PRIV" ${
              shellEscape(confPath(g))
            }`,
            `systemctl restart wg-quick@${shellEscape(g.interfaceName)}`,
            "echo DONE",
          ].join("\n");
          const result = await execSudo(client, script, so);
          if (result.exitCode !== 0) {
            throw new Error(`key rotation failed: ${result.stderr}`);
          }
          const pubkeyResult = await execSudo(
            client,
            `cat ${shellEscape(publicKeyPath(g))}`,
            so,
          );
          const final = await gather(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            interfaceName: g.interfaceName,
            status: "applied",
            up: final.parsed.up,
            publicKey: pubkeyResult.stdout.trim(),
            listenPort: final.parsed.listenPort,
            lastHandshakeAgeSeconds: final.parsed.lastHandshakeAgeSeconds,
            changes: [
              "rotated keypair — hand new public key to peer's apply call",
            ],
            error: null,
            timestamp: new Date().toISOString(),
          });
          context.logger.info(
            "Rotated keypair for {interfaceName} on {host} — new public key: {publicKey}",
            {
              interfaceName: g.interfaceName,
              host: g.nodeHost,
              publicKey: pubkeyResult.stdout.trim(),
            },
          );
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            interfaceName: g.interfaceName,
            status: "failed",
            up: false,
            publicKey: null,
            listenPort: null,
            lastHandshakeAgeSeconds: null,
            changes: [],
            error: (err as Error).message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
  },
  reports: [],
};
