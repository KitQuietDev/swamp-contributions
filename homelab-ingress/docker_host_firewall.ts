/**
 * Ensures a Docker host with a custom nftables ruleset actually lets Docker's
 * networking work. This exists because of two real, separately-discovered
 * bugs (2026-07-27, building a homelab's public ingress on a fresh VPS and
 * on an existing homelab box):
 *
 * 1. A custom `input` or `forward` chain in the same nftables family/table
 *    Docker itself uses (`inet`/`filter` by default) is evaluated
 *    independently of Docker's own `ip filter` table — Docker having a
 *    permissive FORWARD chain does NOT mean a separate custom chain won't
 *    ALSO evaluate (and silently drop) the same packet. A `forward` chain
 *    with `policy drop` and no `docker0`/`br-*` accept rules breaks
 *    container-to-internet and container-to-LAN traffic entirely, even
 *    though the host itself pings/curls fine (host traffic never touches
 *    `forward`). The `input` chain needs the same treatment for traffic
 *    from a container reaching a *host-bound* service (e.g. a reverse
 *    proxy container reaching another container's `network_mode: host`
 *    service via the bridge gateway) — that traffic is host-destined, so
 *    it hits `input`, not `forward`.
 *
 * 2. Reloading such a ruleset with `nft -f` (or anything that does
 *    `flush ruleset`) outside of boot time wipes Docker's own dynamically-
 *    managed `DOCKER`/`DOCKER-FORWARD` chains without Docker knowing to
 *    rebuild them (it only does that at its own daemon startup). Existing
 *    running containers keep working — their individual port-publish rules
 *    were already in place — but anything freshly started or recreated
 *    fails immediately with `iptables: No chain/target/match by that name`,
 *    or has zero outbound connectivity. This model's `apply` avoids the bug
 *    by construction: it only ever uses incremental `nft insert rule`,
 *    never a full reload.
 *
 * Scope: this checks/fixes the two specific chains above for the two
 * specific interface patterns (`docker0`, `br-*`) that caused real breakage.
 * It is not a general-purpose nftables analyzer — table/chain naming is
 * parameterized (defaults match the common `inet filter` convention) but
 * the actual rule requirements are the hard-won, specific ones, not
 * inferred generically.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { execSudo, getConnection, shellEscape } from "./_lib/ssh.ts";

const GlobalArgsSchema = z.object({
  nodeHost: z.string().describe("Hostname or IP of the Docker host"),
  nodeUser: z.string().default("root").describe("SSH username"),
  nodePort: z.number().default(22).describe("SSH port"),
  nodeIdentityFile: z.string().optional().describe(
    "Path to an SSH private key file on the machine running this method",
  ),
  nodeIdentityContent: z.string().optional().meta({ sensitive: true })
    .describe(
      "PEM private key content — supply via ${{ vault.get(vault, key) }}. " +
        "Written to a mode-0600 temp file for the session, removed after.",
    ),
  become: z.boolean().default(false).describe(
    "Enable sudo privilege escalation (leave false if nodeUser is already root)",
  ),
  becomeUser: z.string().default("root").describe("User to become via sudo"),
  becomePassword: z.string().optional().meta({ sensitive: true }).describe(
    "Password for sudo -S, via ${{ vault.get(vault, key) }}",
  ),
  tableFamily: z.string().default("inet").describe(
    "nftables table family (e.g. inet, ip)",
  ),
  tableName: z.string().default("filter").describe("nftables table name"),
  nftablesConfPath: z.string().default("/etc/nftables.conf").describe(
    "Path to the persisted ruleset file, updated alongside the live change so the fix survives a reboot",
  ),
  dockerInterfaces: z.array(z.string()).default(["docker0", "br-*"])
    .describe(
      "Interface name patterns to allow — defaults match Docker's own bridge naming",
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

const ChainFindingSchema = z.object({
  chain: z.enum(["input", "forward"]),
  exists: z.boolean(),
  missingRules: z.array(z.string()),
});

const StateSchema = z.object({
  host: z.string(),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]),
  findings: z.array(ChainFindingSchema),
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

/** Rules required in each chain, as both the live `nft insert rule` fragment and the literal text expected in the persisted file's chain block. */
export function requiredRules(
  chain: "input" | "forward",
  interfaces: string[],
): string[] {
  const rules: string[] = [];
  if (chain === "forward") {
    rules.push("ct state established,related accept");
    for (const iface of interfaces) {
      rules.push(`iifname "${iface}" accept`);
      rules.push(`oifname "${iface}" accept`);
    }
  } else {
    for (const iface of interfaces) {
      rules.push(`iifname "${iface}" accept`);
    }
  }
  return rules;
}

async function gatherChain(
  client: Awaited<ReturnType<typeof connect>>,
  g: GlobalArgs,
  chain: "input" | "forward",
) {
  const result = await execSudo(
    client,
    `nft list chain ${g.tableFamily} ${shellEscape(g.tableName)} ${chain} 2>&1`,
    sudoOpts(g),
  );
  const exists = result.exitCode === 0;
  const required = requiredRules(chain, g.dockerInterfaces);
  const missingRules = exists
    ? required.filter((rule) => !result.stdout.includes(rule))
    : required;
  return { chain, exists, missingRules };
}

/** Reconciles a Docker host's custom nftables `input`/`forward` chains so Docker's own bridge traffic isn't silently dropped. See `check`/`apply` methods below. */
export const model = {
  type: "@kitquiet/homelab-ingress/docker-host-firewall",
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
        "Check whether the input and forward chains accept Docker bridge traffic (dry-run)",
      arguments: z.object({}),
      execute: async (_args: unknown, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info(
          "Checking docker0/br-* accept rules on {host}",
          { host: g.nodeHost },
        );
        try {
          const client = await connect(g);
          const findings = await Promise.all(
            (["input", "forward"] as const).map((c) =>
              gatherChain(client, g, c)
            ),
          );
          const changes = findings.flatMap((f) =>
            f.missingRules.map((r) => `${f.chain}: add "${r}"`)
          );
          const handle = await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            status: changes.length === 0 ? "compliant" : "non_compliant",
            findings,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          context.logger.info(
            "{host} is {status} ({count} missing rules)",
            {
              host: g.nodeHost,
              status: changes.length === 0 ? "compliant" : "non_compliant",
              count: changes.length,
            },
          );
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            status: "failed",
            findings: [],
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
        "Idempotently add missing docker0/br-* accept rules to the input and forward chains, live and in the persisted file. Never does a full ruleset reload.",
      arguments: z.object({}),
      execute: async (_args: unknown, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info(
          "Reconciling docker0/br-* accept rules on {host}",
          { host: g.nodeHost },
        );
        try {
          const client = await connect(g);
          const findings = await Promise.all(
            (["input", "forward"] as const).map((c) =>
              gatherChain(client, g, c)
            ),
          );
          const changes = findings.flatMap((f) =>
            f.missingRules.map((r) => `${f.chain}: add "${r}"`)
          );

          if (changes.length === 0) {
            const handle = await context.writeResource("state", g.nodeHost, {
              host: g.nodeHost,
              status: "compliant",
              findings,
              changes: [],
              error: null,
              timestamp: new Date().toISOString(),
            });
            context.logger.info("{host} already compliant, no changes needed", {
              host: g.nodeHost,
            });
            return { dataHandles: [handle] };
          }

          const errors: string[] = [];
          const so = sudoOpts(g);

          // Live, incremental — never a full reload, so Docker's own chains are never touched.
          for (const f of findings) {
            for (const rule of f.missingRules) {
              const r = await execSudo(
                client,
                `nft insert rule ${g.tableFamily} ${
                  shellEscape(g.tableName)
                } ${f.chain} ${rule}`,
                so,
              );
              if (r.exitCode !== 0) {
                errors.push(`live insert (${f.chain}: ${rule}): ${r.stderr}`);
              }
            }
          }

          // Persist to the ruleset file so the fix survives a reboot. Insert
          // each missing rule right after the chain's opening brace line —
          // safe because we only ever add lines, never remove or reorder.
          for (const f of findings) {
            if (f.missingRules.length === 0) continue;
            const insertLines = f.missingRules.map((r) => `        ${r}`).join(
              "\\n",
            );
            // sed: find the chain's opening line, append the missing rules after it.
            const sedScript = `/chain ${f.chain} {/a\\\n${
              insertLines.replace(/"/g, '\\"')
            }`;
            const r = await execSudo(
              client,
              `sed -i ${shellEscape(sedScript)} ${
                shellEscape(g.nftablesConfPath)
              } && nft -c -f ${shellEscape(g.nftablesConfPath)}`,
              so,
            );
            if (r.exitCode !== 0) {
              errors.push(
                `persist to ${g.nftablesConfPath} (${f.chain}): ${r.stderr}`,
              );
            }
          }

          const updated = await Promise.all(
            (["input", "forward"] as const).map((c) =>
              gatherChain(client, g, c)
            ),
          );
          const failed = errors.length > 0;
          const handle = await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            status: failed ? "failed" : "applied",
            findings: updated,
            changes,
            error: failed ? errors.join("; ") : null,
            timestamp: new Date().toISOString(),
          });
          if (failed) throw new Error(errors.join("; "));
          context.logger.info(
            "Applied {count} rule(s) to {host}",
            { count: changes.length, host: g.nodeHost },
          );
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            status: "failed",
            findings: [],
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
