/**
 * Host port inventory — catalogs TCP ports currently listening on the local
 * host, correlating each with the owning process (via `ss`) and, where
 * applicable, the Docker container that published it (via `docker ps`).
 *
 * Read-only: this model never binds, kills, or otherwise touches a port or
 * process, it only inspects. Useful as a pre-flight check before wiring a new
 * service to a port — query the last snapshot instead of finding out the hard
 * way with `EADDRINUSE`.
 *
 * Process attribution for sockets owned by another user (e.g. root-owned
 * `docker-proxy` or system daemons) requires `sudo ss`, which is opt-in via
 * `useSudo` and requires passwordless sudo for `ss` — without it, `pid`/
 * `process` are only populated for sockets owned by the user running swamp.
 *
 * IPv4 and IPv6 TCP listeners only — UDP is out of scope for this version.
 *
 * @module
 */
// extensions/models/host-ports-ext/host_ports.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  useSudo: z.boolean().default(false).describe(
    "Run `sudo ss` to resolve pid/process for sockets owned by other users " +
      "(e.g. root-owned docker-proxy or system daemons). Requires " +
      "passwordless sudo for `ss` on this host. Defaults to false.",
  ),
  includeDocker: z.boolean().default(true).describe(
    "Correlate listening ports with `docker ps` published port mappings. " +
      "Set to false on hosts without Docker installed.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ListeningPortSchema = z.object({
  port: z.number(),
  protocol: z.literal("tcp"),
  address: z.string(),
  pid: z.number().nullable(),
  process: z.string().nullable(),
  dockerContainer: z.string().nullable(),
});

type ParsedPort = {
  port: number;
  protocol: "tcp";
  address: string;
  pid: number | null;
  process: string | null;
};

/** Parse `ss -ltnp` output into structured listening-port records. */
export function parseSsOutput(output: string): ParsedPort[] {
  const lines = output.trim().split("\n").slice(1);
  const ports: ParsedPort[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;

    const match = cols[3].match(/^(.*):(\d+)$/);
    if (!match) continue;

    const processInfo = cols.slice(5).join(" ");
    const procMatch = processInfo.match(/users:\(\("([^"]+)",pid=(\d+)/);

    ports.push({
      port: Number(match[2]),
      protocol: "tcp",
      address: match[1],
      pid: procMatch ? Number(procMatch[2]) : null,
      process: procMatch ? procMatch[1] : null,
    });
  }

  return ports;
}

/** Parse `docker ps --format '{{json .}}'` output into a `proto:hostPort -> containerName` map. */
export function parseDockerPsOutput(output: string): Map<string, string> {
  const map = new Map<string, string>();

  for (const line of output.trim().split("\n")) {
    if (!line.trim()) continue;
    let entry: { Names?: string; Ports?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry.Names || !entry.Ports) continue;

    for (const mapping of entry.Ports.split(",")) {
      const match = mapping.trim().match(/(?:.*:)?(\d+)->\d+\/(tcp|udp)$/);
      if (!match) continue;
      map.set(`${match[2]}:${match[1]}`, entry.Names);
    }
  }

  return map;
}

async function runSs(useSudo: boolean): Promise<ParsedPort[]> {
  const cmd = useSudo
    ? new Deno.Command("sudo", {
      args: ["ss", "-ltnp"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    })
    : new Deno.Command("ss", {
      args: ["-ltnp"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });

  const output = await cmd.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr);
    throw new Error(
      `ss ${useSudo ? "(via sudo) " : ""}failed: ${stderr.slice(0, 500)}`,
    );
  }
  return parseSsOutput(new TextDecoder().decode(output.stdout));
}

/** Turn a bind address into a stable, filesystem-safe instance-name fragment. */
export function sanitizeAddressForName(address: string): string {
  const cleaned = address.replace(/[^a-zA-Z0-9]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
  return cleaned || "unspecified";
}

async function runDockerPortMap(): Promise<Map<string, string>> {
  try {
    const cmd = new Deno.Command("docker", {
      args: ["ps", "--format", "{{json .}}"],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (!output.success) return new Map();
    return parseDockerPsOutput(new TextDecoder().decode(output.stdout));
  } catch {
    return new Map();
  }
}

type LoggerContext = {
  logger: { info(msg: string, ...args: unknown[]): void };
};

/** Host port inventory: catalogs listening TCP ports and correlates them with owning processes and Docker containers. */
export const model = {
  type: "@kitquiet/host-ports",
  version: "2026.07.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "listening_port": {
      description:
        "A TCP port currently listening on the host, with owning process and Docker container correlation where known",
      schema: ListeningPortSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
  },
  methods: {
    list_listening_ports: {
      description:
        "Catalog all TCP ports currently listening on the host (read-only)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, unknown>,
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        context.logger.info(
          "Cataloging listening TCP ports (useSudo={useSudo}, includeDocker={includeDocker})",
          {
            useSudo: context.globalArgs.useSudo,
            includeDocker: context.globalArgs.includeDocker,
          },
        );

        const ports = await runSs(context.globalArgs.useSudo);
        const dockerMap = context.globalArgs.includeDocker
          ? await runDockerPortMap()
          : new Map<string, string>();

        const handles = [];
        for (const p of ports) {
          const handle = await context.writeResource(
            "listening_port",
            `tcp-${p.port}-${sanitizeAddressForName(p.address)}`,
            {
              port: p.port,
              protocol: p.protocol,
              address: p.address,
              pid: p.pid,
              process: p.process,
              dockerContainer: dockerMap.get(`tcp:${p.port}`) ?? null,
            },
          );
          handles.push(handle);
        }

        context.logger.info("Found {count} listening TCP ports", {
          count: ports.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
