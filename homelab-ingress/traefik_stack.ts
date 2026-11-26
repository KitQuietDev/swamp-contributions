/**
 * Deploys and manages a Traefik reverse-proxy stack via SSH — its own
 * Let's-Encrypt HTTP-01 certificates (no DNS-provider API dependency by
 * design), a file-provider dynamic config, and JSON access logging (so
 * `fail2ban_jail` has something real to watch).
 *
 * `add-route`/`remove-route` parse and rewrite the dynamic config as real
 * YAML (via the `yaml` package) rather than text-editing — the hand-rolled
 * `sed`-based approach used building the reference deployment this package
 * is based on worked, but broke twice on file-copy edge cases along the way.
 * Parsing means every route stays independently addressable and untouched
 * by edits to any other route.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { parse as parseYaml, stringify as stringifyYaml } from "npm:yaml@2.8.3";
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
  deployPath: z.string().default("/opt/traefik-stack").describe(
    "Remote directory to hold compose file, static/dynamic config, ACME storage, and logs",
  ),
  acmeEmail: z.string().describe("Contact email for Let's Encrypt"),
  letsEncryptStaging: z.boolean().default(false).describe(
    "Use Let's Encrypt's staging CA — avoids production rate limits while testing, certs won't be browser-trusted",
  ),
  image: z.string().default("traefik:v3.3").describe("Traefik image"),
  networkName: z.string().default("edge").describe(
    "Docker network name the stack's containers join",
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
  status: z.enum(["compliant", "non_compliant", "applied", "failed"]),
  running: z.boolean(),
  changes: z.array(z.string()),
  error: z.string().nullable(),
  timestamp: z.string(),
});

const RouteStateSchema = z.object({
  host: z.string(),
  routerName: z.string(),
  action: z.enum(["added", "updated", "removed", "unchanged", "failed"]),
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

function staticConfigPath(g: GlobalArgs): string {
  return `${g.deployPath}/traefik.yml`;
}

function dynamicConfigPath(g: GlobalArgs): string {
  return `${g.deployPath}/dynamic.yml`;
}

function composePath(g: GlobalArgs): string {
  return `${g.deployPath}/docker-compose.yml`;
}

/** The desired `traefik.yml` static config: ACME HTTP-01 (no DNS-provider API), file-provider dynamic config, JSON access logging. */
export function desiredStaticConfig(g: GlobalArgs): string {
  return stringifyYaml({
    entryPoints: {
      web: {
        address: ":80",
        http: {
          redirections: { entryPoint: { to: "websecure", scheme: "https" } },
        },
      },
      websecure: { address: ":443" },
    },
    certificatesResolvers: {
      letsencrypt: {
        acme: {
          email: g.acmeEmail,
          storage: "/acme/acme.json",
          httpChallenge: { entryPoint: "web" },
          ...(g.letsEncryptStaging
            ? {
              caServer:
                "https://acme-staging-v02.api.letsencrypt.org/directory",
            }
            : {}),
        },
      },
    },
    providers: { file: { filename: "/etc/traefik/dynamic.yml", watch: true } },
    api: { dashboard: false },
    log: { level: "INFO" },
    accessLog: { filePath: "/var/log/traefik/access.log", format: "json" },
  });
}

/** The desired `docker-compose.yml` for the Traefik container itself. */
export function desiredComposeFile(g: GlobalArgs): string {
  return stringifyYaml({
    services: {
      traefik: {
        image: g.image,
        container_name: "traefik",
        restart: "unless-stopped",
        extra_hosts: ["host.docker.internal:host-gateway"],
        ports: ["80:80", "443:443"],
        volumes: [
          "./traefik.yml:/etc/traefik/traefik.yml:ro",
          "./dynamic.yml:/etc/traefik/dynamic.yml:ro",
          "./acme:/acme",
          "./logs:/var/log/traefik",
        ],
        networks: [g.networkName],
      },
    },
    networks: { [g.networkName]: { driver: "bridge" } },
  });
}

/** A fresh `dynamic.yml` with no routers/services/middlewares yet — `add-route` and `authelia_gate` populate it from here. */
export function emptyDynamicConfig(): string {
  return stringifyYaml({
    http: { middlewares: {}, routers: {}, services: {} },
  });
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

async function isRunning(
  client: Awaited<ReturnType<typeof connect>>,
  g: GlobalArgs,
): Promise<boolean> {
  const result = await execSudo(
    client,
    `docker inspect -f '{{.State.Running}}' traefik 2>/dev/null`,
    sudoOpts(g),
  );
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/** Deploys/manages a Traefik reverse-proxy stack via SSH with its own Let's Encrypt HTTP-01 certs and a file-provider dynamic config. See `check`/`apply`/`add-route`/`remove-route` methods below. */
export const model = {
  type: "@kitquiet/homelab-ingress/traefik-stack",
  version: "2026.07.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description: "Result of check or apply operation",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    route: {
      description: "Result of an add-route/remove-route operation",
      schema: RouteStateSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    check: {
      description:
        "Check whether the stack is deployed with current config and running (dry-run)",
      arguments: z.object({}),
      execute: async (_args: unknown, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info("Checking Traefik stack on {host}", {
          host: g.nodeHost,
        });
        try {
          const client = await connect(g);
          const running = await isRunning(client, g);
          const staticConf = await readRemoteFile(
            client,
            g,
            staticConfigPath(g),
          );
          const changes: string[] = [];
          if (!running) changes.push("start stack");
          if (staticConf === null) changes.push("write static config");
          else if (staticConf.trim() !== desiredStaticConfig(g).trim()) {
            changes.push("update static config");
          }

          const handle = await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            status: changes.length === 0 ? "compliant" : "non_compliant",
            running,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          context.logger.info("Traefik stack on {host} is {status}", {
            host: g.nodeHost,
            status: changes.length === 0 ? "compliant" : "non_compliant",
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            status: "failed",
            running: false,
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
        "Deploy or update the Traefik stack — writes config, brings the stack up if needed",
      arguments: z.object({}),
      execute: async (_args: unknown, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info("Deploying Traefik stack to {host}", {
          host: g.nodeHost,
        });
        try {
          const client = await connect(g);
          const so = sudoOpts(g);
          const changes: string[] = [];

          await execSudo(
            client,
            `mkdir -p ${shellEscape(g.deployPath)} ${
              shellEscape(g.deployPath + "/acme")
            } ${shellEscape(g.deployPath + "/logs")}`,
            so,
          );

          const currentStatic = await readRemoteFile(
            client,
            g,
            staticConfigPath(g),
          );
          const desiredStatic = desiredStaticConfig(g);
          if (
            currentStatic === null ||
            currentStatic.trim() !== desiredStatic.trim()
          ) {
            await writeFileAs(client, staticConfigPath(g), desiredStatic, so);
            changes.push(
              currentStatic === null
                ? "created static config"
                : "updated static config",
            );
          }

          const currentDynamic = await readRemoteFile(
            client,
            g,
            dynamicConfigPath(g),
          );
          if (currentDynamic === null) {
            await writeFileAs(
              client,
              dynamicConfigPath(g),
              emptyDynamicConfig(),
              so,
            );
            changes.push("created empty dynamic config");
          }

          const currentCompose = await readRemoteFile(
            client,
            g,
            composePath(g),
          );
          const desiredCompose = desiredComposeFile(g);
          if (
            currentCompose === null ||
            currentCompose.trim() !== desiredCompose.trim()
          ) {
            await writeFileAs(client, composePath(g), desiredCompose, so);
            changes.push(
              currentCompose === null
                ? "created compose file"
                : "updated compose file",
            );
          }

          const running = await isRunning(client, g);
          if (changes.length > 0 || !running) {
            const up = await execSudo(
              client,
              `cd ${shellEscape(g.deployPath)} && docker compose up -d`,
              so,
            );
            if (up.exitCode !== 0) {
              throw new Error(`docker compose up failed: ${up.stderr}`);
            }
            if (!running) changes.push("started stack");
          }

          const finalRunning = await isRunning(client, g);
          const handle = await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            status: changes.length === 0 ? "compliant" : "applied",
            running: finalRunning,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          context.logger.info(
            "Applied {count} change(s) to Traefik stack on {host}",
            { count: changes.length, host: g.nodeHost },
          );
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            status: "failed",
            running: false,
            changes: [],
            error: (err as Error).message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
    "add-route": {
      description:
        "Idempotently add or update one router+service in the dynamic config, without touching any other route",
      arguments: z.object({
        routerName: z.string().describe(
          "Unique router/service identifier, e.g. 'photos'",
        ),
        hostname: z.string().describe(
          "Public hostname to match, e.g. 'photos.example.com'",
        ),
        backendUrl: z.string().describe(
          "Where to forward matched requests, e.g. 'http://192.0.2.2:2283'",
        ),
        middlewares: z.array(z.string()).default([]).describe(
          "Names of already-defined middlewares to apply, e.g. ['authelia']",
        ),
        certResolver: z.string().default("letsencrypt"),
      }),
      execute: async (args: {
        routerName: string;
        hostname: string;
        backendUrl: string;
        middlewares: string[];
        certResolver: string;
      }, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info(
          "Adding route {routerName} ({hostname}) on {host}",
          {
            routerName: args.routerName,
            hostname: args.hostname,
            host: g.nodeHost,
          },
        );
        try {
          const client = await connect(g);
          const so = sudoOpts(g);
          const current = await readRemoteFile(client, g, dynamicConfigPath(g));
          // deno-lint-ignore no-explicit-any
          const doc: any = current ? parseYaml(current) : { http: {} };
          doc.http ??= {};
          doc.http.routers ??= {};
          doc.http.services ??= {};

          const svcName = `${args.routerName}-svc`;
          const desiredRouter: Record<string, unknown> = {
            rule: `Host(\`${args.hostname}\`)`,
            entrypoints: "websecure",
            tls: { certresolver: args.certResolver },
            service: svcName,
          };
          if (args.middlewares.length > 0) {
            desiredRouter.middlewares = args.middlewares;
          }
          const desiredService = {
            loadBalancer: { servers: [{ url: args.backendUrl }] },
          };

          const existingRouter = doc.http.routers[args.routerName];
          const existingService = doc.http.services[svcName];
          const unchanged = existingRouter &&
            JSON.stringify(existingRouter) === JSON.stringify(desiredRouter) &&
            existingService &&
            JSON.stringify(existingService) === JSON.stringify(desiredService);

          let action: "added" | "updated" | "unchanged" = "unchanged";
          if (!unchanged) {
            action = existingRouter ? "updated" : "added";
            doc.http.routers[args.routerName] = desiredRouter;
            doc.http.services[svcName] = desiredService;
            await writeFileAs(
              client,
              dynamicConfigPath(g),
              stringifyYaml(doc),
              so,
            );
          }

          const handle = await context.writeResource("route", args.routerName, {
            host: g.nodeHost,
            routerName: args.routerName,
            action,
            error: null,
            timestamp: new Date().toISOString(),
          });
          context.logger.info("Route {routerName} on {host}: {action}", {
            routerName: args.routerName,
            host: g.nodeHost,
            action,
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("route", args.routerName, {
            host: g.nodeHost,
            routerName: args.routerName,
            action: "failed",
            error: (err as Error).message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
      },
    },
    "remove-route": {
      description:
        "Remove one router+service from the dynamic config, if present. No-op if absent.",
      arguments: z.object({
        routerName: z.string().describe("Router/service identifier to remove"),
      }),
      execute: async (args: { routerName: string }, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info("Removing route {routerName} on {host}", {
          routerName: args.routerName,
          host: g.nodeHost,
        });
        try {
          const client = await connect(g);
          const so = sudoOpts(g);
          const current = await readRemoteFile(client, g, dynamicConfigPath(g));
          // deno-lint-ignore no-explicit-any
          const doc: any = current ? parseYaml(current) : { http: {} };
          const svcName = `${args.routerName}-svc`;
          const existed = Boolean(doc?.http?.routers?.[args.routerName]);
          if (existed) {
            delete doc.http.routers[args.routerName];
            delete doc.http.services[svcName];
            await writeFileAs(
              client,
              dynamicConfigPath(g),
              stringifyYaml(doc),
              so,
            );
          }

          const handle = await context.writeResource("route", args.routerName, {
            host: g.nodeHost,
            routerName: args.routerName,
            action: existed ? "removed" : "unchanged",
            error: null,
            timestamp: new Date().toISOString(),
          });
          context.logger.info("Route {routerName} on {host}: {action}", {
            routerName: args.routerName,
            host: g.nodeHost,
            action: existed ? "removed" : "unchanged",
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("route", args.routerName, {
            host: g.nodeHost,
            routerName: args.routerName,
            action: "failed",
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
