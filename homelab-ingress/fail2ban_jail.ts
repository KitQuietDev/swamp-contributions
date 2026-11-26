/**
 * Manages one fail2ban filter+jail on a remote host via SSH. Uses
 * `nftables-multiport` as the ban action by default — it creates its own
 * isolated `f2b-table` (confirmed by reading the actual action config: it
 * only ever does `nft add table`/`add element`/`delete element`, never a
 * full ruleset reload), so it can never interact with the
 * `docker_host_firewall` flush-wipes-Docker's-chains bug in this same
 * package, regardless of deployment order.
 *
 * `apply` always explicitly restarts (not just `enable --now`) after
 * writing config — fail2ban is commonly already running from the package's
 * own postinst script by the time this runs, and `enable --now` against an
 * already-active service is a no-op that will *not* pick up a freshly
 * written jail.d file. This was discovered the hard way building the
 * reference deployment: the jail silently never loaded until an explicit
 * restart, despite `enable --now` reporting success.
 *
 * This model owns one jail per file, at `jail.d/<jailName>.local`. It has no
 * way to safely merge into a hand-built deployment that bundles several
 * jails into one file — so before writing, `apply` greps fail2ban's other
 * jail config locations for an existing `[jailName]` section
 * (`findJailDefinedElsewhere`) and refuses with a descriptive error rather
 * than creating a second, competing definition of the same jail name.
 * `check` surfaces the same finding non-destructively. Verified against a
 * real hand-configured instance during development, which bundles jails
 * into a single `jail.d/custom.local` file — without this guard, `apply`
 * would have created a conflicting `jail.d/traefik-badbots.local` alongside
 * it.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  execSudo,
  getConnection,
  shellEscape,
  writeFileAs,
} from "./_lib/ssh.ts";

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
  jailName: z.string().describe("Jail identifier, e.g. 'traefik-badbots'"),
  filterRegex: z.string().describe(
    'failregex pattern using the <HOST> tag, e.g. \'^.*"ClientHost":"<HOST>".*"RequestPath":"(/\\.env.*)".*$\'',
  ),
  logPath: z.string().describe("Path to the log file this jail watches"),
  maxRetry: z.number().default(3),
  findTime: z.string().default("10m"),
  banTime: z.string().default("1h"),
  port: z.string().default("http,https"),
  protocol: z.string().default("tcp"),
  banAction: z.string().default("nftables-multiport").describe(
    "fail2ban action — the default uses its own isolated nftables table, safe alongside docker_host_firewall",
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
  jailName: z.string(),
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]),
  active: z.boolean(),
  currentlyBanned: z.number().nullable(),
  totalBanned: z.number().nullable(),
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

const filterPath = (g: GlobalArgs) =>
  `/etc/fail2ban/filter.d/${g.jailName}.conf`;
const jailPath = (g: GlobalArgs) => `/etc/fail2ban/jail.d/${g.jailName}.local`;

/** The desired `filter.d/<jailName>.conf` content — just the supplied failregex under `[Definition]`. */
export function desiredFilter(g: GlobalArgs): string {
  return `[Definition]\nfailregex = ${g.filterRegex}\nignoreregex =\n`;
}

/** The desired `jail.d/<jailName>.local` content for this jail. */
export function desiredJail(g: GlobalArgs): string {
  return [
    `[${g.jailName}]`,
    "enabled = true",
    `filter = ${g.jailName}`,
    `logpath = ${g.logPath}`,
    `maxretry = ${g.maxRetry}`,
    `findtime = ${g.findTime}`,
    `bantime = ${g.banTime}`,
    `port = ${g.port}`,
    `protocol = ${g.protocol}`,
    `banaction = ${g.banAction}`,
    "",
  ].join("\n");
}

async function readRemoteFile(
  client: Awaited<ReturnType<typeof connect>>,
  g: GlobalArgs,
  path: string,
): Promise<string | null> {
  const result = await execSudo(
    client,
    `cat ${shellEscape(path)} 2>/dev/null`,
    sudoOpts(g),
  );
  return result.exitCode === 0 ? result.stdout : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Searches fail2ban's other jail config locations for a `[jailName]` section
 * that isn't the file this model manages — e.g. a hand-built deployment that
 * bundles several jails into one file like `jail.d/custom.local`. Returns
 * the path it was found in, or null if the jail isn't defined anywhere else.
 * `apply` uses this to refuse rather than write a second, competing
 * definition of the same jail name.
 */
export async function findJailDefinedElsewhere(
  client: Awaited<ReturnType<typeof connect>>,
  g: GlobalArgs,
): Promise<string | null> {
  const pattern = `^\\[${escapeRegex(g.jailName)}\\]$`;
  const result = await execSudo(
    client,
    `grep -rlE ${
      shellEscape(pattern)
    } /etc/fail2ban/jail.d/ /etc/fail2ban/jail.local /etc/fail2ban/jail.conf 2>/dev/null`,
    sudoOpts(g),
  );
  // grep exits non-zero both for "no match" and for "one of several target
  // paths doesn't exist" (common here — jail.local/jail.conf are optional) —
  // those two cases are indistinguishable via exit code alone. Read stdout
  // instead: a matched file path was found regardless of what else failed.
  const ownPath = jailPath(g);
  const paths = result.stdout.trim().split("\n").filter(Boolean).filter(
    (p) => p !== ownPath,
  );
  return paths.length > 0 ? paths[0] : null;
}

interface JailStatus {
  active: boolean;
  currentlyBanned: number | null;
  totalBanned: number | null;
}

async function gatherStatus(
  client: Awaited<ReturnType<typeof connect>>,
  g: GlobalArgs,
): Promise<JailStatus> {
  const result = await execSudo(
    client,
    `fail2ban-client status ${shellEscape(g.jailName)} 2>&1`,
    sudoOpts(g),
  );
  if (result.exitCode !== 0) {
    return { active: false, currentlyBanned: null, totalBanned: null };
  }
  const currentMatch = result.stdout.match(/Currently banned:\s*(\d+)/);
  const totalMatch = result.stdout.match(/Total banned:\s*(\d+)/);
  return {
    active: true,
    currentlyBanned: currentMatch ? parseInt(currentMatch[1]) : null,
    totalBanned: totalMatch ? parseInt(totalMatch[1]) : null,
  };
}

/** Manages one fail2ban filter+jail on a remote host via SSH, one jail per file. See `check`/`apply`/`unban` methods below. */
export const model = {
  type: "@kitquiet/homelab-ingress/fail2ban-jail",
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
        "Check filter/jail config and whether the jail is actually active (dry-run)",
      arguments: z.object({}),
      execute: async (_args: unknown, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info("Checking jail {jailName} on {host}", {
          jailName: g.jailName,
          host: g.nodeHost,
        });
        try {
          const client = await connect(g);
          const [currentFilter, currentJail, status] = await Promise.all([
            readRemoteFile(client, g, filterPath(g)),
            readRemoteFile(client, g, jailPath(g)),
            gatherStatus(client, g),
          ]);
          const changes: string[] = [];
          if (
            currentFilter === null ||
            currentFilter.trim() !== desiredFilter(g).trim()
          ) {
            changes.push(
              currentFilter === null ? "create filter" : "update filter",
            );
          }
          if (currentJail === null) {
            const elsewhere = await findJailDefinedElsewhere(client, g);
            changes.push(
              elsewhere
                ? `jail already defined in ${elsewhere} — apply would refuse rather than create a duplicate`
                : "create jail config",
            );
          } else if (currentJail.trim() !== desiredJail(g).trim()) {
            changes.push("update jail config");
          }
          if (!status.active) {
            changes.push("jail not active — needs fail2ban restart to load");
          }

          const handle = await context.writeResource("state", g.jailName, {
            host: g.nodeHost,
            jailName: g.jailName,
            status: changes.length === 0 ? "compliant" : "non_compliant",
            active: status.active,
            currentlyBanned: status.currentlyBanned,
            totalBanned: status.totalBanned,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          context.logger.info("Jail {jailName} on {host} is {status}", {
            jailName: g.jailName,
            host: g.nodeHost,
            status: changes.length === 0 ? "compliant" : "non_compliant",
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.jailName, {
            host: g.nodeHost,
            jailName: g.jailName,
            status: "failed",
            active: false,
            currentlyBanned: null,
            totalBanned: null,
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
        "Write filter+jail config, install fail2ban if missing, and always explicitly restart to actually load the jail (enable --now alone won't pick up a fresh jail.d file on an already-running service)",
      arguments: z.object({}),
      execute: async (_args: unknown, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info("Applying jail {jailName} on {host}", {
          jailName: g.jailName,
          host: g.nodeHost,
        });
        try {
          const client = await connect(g);
          const so = sudoOpts(g);
          const changes: string[] = [];

          const installCheck = await execSudo(
            client,
            "which fail2ban-client",
            so,
          );
          if (installCheck.exitCode !== 0) {
            const install = await execSudo(
              client,
              "apt-get update -qq && apt-get install -y -qq fail2ban",
              so,
            );
            if (install.exitCode !== 0) {
              throw new Error(`fail2ban install failed: ${install.stderr}`);
            }
            changes.push("installed fail2ban package");
          }

          const currentFilter = await readRemoteFile(client, g, filterPath(g));
          const desiredFilterContent = desiredFilter(g);
          if (
            currentFilter === null ||
            currentFilter.trim() !== desiredFilterContent.trim()
          ) {
            await writeFileAs(client, filterPath(g), desiredFilterContent, so);
            changes.push(
              currentFilter === null ? "created filter" : "updated filter",
            );
          }

          const currentJail = await readRemoteFile(client, g, jailPath(g));
          if (currentJail === null) {
            const elsewhere = await findJailDefinedElsewhere(client, g);
            if (elsewhere) {
              throw new Error(
                `jail '${g.jailName}' is already defined in ${elsewhere}, not at the expected path ${
                  jailPath(g)
                } — this extension manages one jail per file and won't create a competing duplicate definition. Either point jailName at a host where this extension owns the jail files, or migrate the existing definition out of ${elsewhere} first.`,
              );
            }
          }
          const desiredJailContent = desiredJail(g);
          if (
            currentJail === null ||
            currentJail.trim() !== desiredJailContent.trim()
          ) {
            await writeFileAs(client, jailPath(g), desiredJailContent, so);
            changes.push(
              currentJail === null
                ? "created jail config"
                : "updated jail config",
            );
          }

          const beforeStatus = await gatherStatus(client, g);

          // Always restart, not enable --now: fail2ban is typically already
          // running (its own postinst starts it), and enable --now against an
          // already-active service is a no-op that ignores fresh jail.d files.
          if (changes.length > 0 || !beforeStatus.active) {
            const enable = await execSudo(
              client,
              "systemctl enable fail2ban",
              so,
            );
            if (enable.exitCode !== 0) {
              throw new Error(`fail2ban enable failed: ${enable.stderr}`);
            }
            const restart = await execSudo(
              client,
              "systemctl restart fail2ban",
              so,
            );
            if (restart.exitCode !== 0) {
              throw new Error(`fail2ban restart failed: ${restart.stderr}`);
            }
            changes.push("restarted fail2ban to load jail");
          }

          const finalStatus = await gatherStatus(client, g);
          if (!finalStatus.active) {
            throw new Error(
              `jail still not active after restart — check filter regex syntax and logpath ${g.logPath} exists`,
            );
          }

          const handle = await context.writeResource("state", g.jailName, {
            host: g.nodeHost,
            jailName: g.jailName,
            status: changes.length === 0 ? "compliant" : "applied",
            active: finalStatus.active,
            currentlyBanned: finalStatus.currentlyBanned,
            totalBanned: finalStatus.totalBanned,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          context.logger.info(
            "Applied {count} change(s) to jail {jailName} on {host}",
            { count: changes.length, jailName: g.jailName, host: g.nodeHost },
          );
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.jailName, {
            host: g.nodeHost,
            jailName: g.jailName,
            status: "failed",
            active: false,
            currentlyBanned: null,
            totalBanned: null,
            changes: [],
            error: (err as Error).message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
    unban: {
      description:
        "Unban a specific IP from this jail (imperative, always runs)",
      arguments: z.object({ ip: z.string().describe("IP address to unban") }),
      execute: async (args: { ip: string }, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info("Unbanning {ip} from jail {jailName} on {host}", {
          ip: args.ip,
          jailName: g.jailName,
          host: g.nodeHost,
        });
        try {
          const client = await connect(g);
          const result = await execSudo(
            client,
            `fail2ban-client set ${shellEscape(g.jailName)} unbanip ${
              shellEscape(args.ip)
            }`,
            sudoOpts(g),
          );
          const status = await gatherStatus(client, g);
          const failed = result.exitCode !== 0;
          const handle = await context.writeResource("state", g.jailName, {
            host: g.nodeHost,
            jailName: g.jailName,
            status: failed ? "failed" : "applied",
            active: status.active,
            currentlyBanned: status.currentlyBanned,
            totalBanned: status.totalBanned,
            changes: [`unban ${args.ip}`],
            error: failed ? result.stderr : null,
            timestamp: new Date().toISOString(),
          });
          if (failed) throw new Error(result.stderr);
          context.logger.info("Unbanned {ip} from jail {jailName} on {host}", {
            ip: args.ip,
            jailName: g.jailName,
            host: g.nodeHost,
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.jailName, {
            host: g.nodeHost,
            jailName: g.jailName,
            status: "failed",
            active: false,
            currentlyBanned: null,
            totalBanned: null,
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
