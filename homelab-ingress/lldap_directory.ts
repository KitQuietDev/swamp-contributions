/**
 * Deploys and manages LLDAP (a lightweight LDAP server built for exactly
 * this kind of homelab identity-directory use case) as the shared user
 * directory backing an `authelia_gate` instance's `authBackend: "ldap"`
 * mode — one place to manage users/groups instead of hand-editing Authelia's
 * flat `users_database.yml` per person.
 *
 * Deployment (`apply`) generates the JWT secret, key seed, and admin
 * bootstrap password on the target host itself (`openssl rand`, written
 * directly to a secrets file) — none of them are ever captured back over
 * the SSH exec channel, matching the discipline `authelia_gate` already
 * uses for its own secrets.
 *
 * User/group management (`add-user`) uses LLDAP's own official `bootstrap.sh`
 * script (baked into the `lldap/lldap` image at `/app/bootstrap.sh`,
 * confirmed via the upstream repo's `example_configs/bootstrap/bootstrap.md`)
 * rather than hand-rolled GraphQL calls — it's the tool LLDAP's own
 * maintainers built for declarative user/group convergence, and reusing it
 * means this extension inherits its idempotency instead of reimplementing
 * it. A fresh initial password is generated on-host and never returned to
 * us — only written to a per-user secrets file the operator retrieves once
 * over SSH, mirroring `add-user`'s discipline elsewhere in this package.
 * Re-running `add-user` against an existing username checks first (via a
 * live GraphQL query) and omits the `password` field from the bootstrap
 * JSON when the user already exists, so a re-`apply` never silently resets
 * a password someone has since changed themselves.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { stringify as stringifyYaml } from "npm:yaml@2.8.3";
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
  deployPath: z.string().default("/opt/lldap-stack").describe(
    "Remote directory to hold compose file, config, secrets, and data",
  ),
  image: z.string().default("lldap/lldap:stable"),
  ldapBaseDn: z.string().describe(
    "e.g. 'dc=example,dc=com' — must match the base_dn given to any authelia_gate instance pointed at this directory",
  ),
  adminUsername: z.string().default("admin").describe(
    "LLDAP's built-in bootstrap admin account username",
  ),
  networkName: z.string().default("edge").describe(
    "Docker network name — must match the traefik_stack/authelia_gate instances that need to reach this directory by container name",
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

const UserStateSchema = z.object({
  host: z.string(),
  username: z.string(),
  action: z.enum(["added", "updated", "failed"]),
  initialPasswordPath: z.string().nullable().describe(
    "Host path holding the plaintext initial password on 'added' — null on 'updated' since existing passwords are never touched",
  ),
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

const composePath = (g: GlobalArgs) => `${g.deployPath}/docker-compose.yml`;
const secretsDir = (g: GlobalArgs) => `${g.deployPath}/secrets`;
const envFilePath = (g: GlobalArgs) => `${secretsDir(g)}/lldap.env`;
const adminPasswordPath = (g: GlobalArgs) => `${secretsDir(g)}/admin_password`;
const bootstrapDir = (g: GlobalArgs) => `${g.deployPath}/bootstrap`;
const userConfigsDir = (g: GlobalArgs) => `${bootstrapDir(g)}/user-configs`;
const groupConfigsDir = (g: GlobalArgs) => `${bootstrapDir(g)}/group-configs`;
const initialPasswordsDir = (g: GlobalArgs) =>
  `${secretsDir(g)}/initial-passwords`;

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
    `docker inspect -f '{{.State.Running}}' lldap 2>/dev/null`,
    sudoOpts(g),
  );
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

/** The desired `docker-compose.yml` for the LLDAP container itself. */
export function desiredComposeFile(g: GlobalArgs): string {
  return stringifyYaml({
    services: {
      lldap: {
        image: g.image,
        container_name: "lldap",
        restart: "unless-stopped",
        env_file: ["./secrets/lldap.env"],
        environment: {
          LLDAP_LDAP_BASE_DN: g.ldapBaseDn,
        },
        volumes: [
          "./data:/data",
          "./secrets:/secrets:ro",
          "./bootstrap:/bootstrap",
        ],
        networks: [g.networkName],
      },
    },
    networks: { [g.networkName]: { external: true } },
  });
}

/** Deploys/manages LLDAP as a shared user directory for one or more paired `authelia_gate` instances. See `check`/`apply`/`add-user` methods below. */
export const model = {
  type: "@kitquiet/homelab-ingress/lldap-directory",
  version: "2026.07.28.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description: "Result of check or apply operation",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    user: {
      description: "Result of an add-user operation",
      schema: UserStateSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    check: {
      description: "Check deployment/config state and running status (dry-run)",
      arguments: z.object({}),
      execute: async (_args: unknown, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info("Checking LLDAP directory on {host}", {
          host: g.nodeHost,
        });
        try {
          const client = await connect(g);
          const running = await isRunning(client, g);
          const currentCompose = await readRemoteFile(
            client,
            g,
            composePath(g),
          );
          const changes: string[] = [];
          if (!running) changes.push("start stack");
          if (currentCompose === null) changes.push("write compose file");
          else if (
            currentCompose.trim() !== desiredComposeFile(g).trim()
          ) {
            changes.push("update compose file");
          }

          const handle = await context.writeResource("state", g.nodeHost, {
            host: g.nodeHost,
            status: changes.length === 0 ? "compliant" : "non_compliant",
            running,
            changes,
            error: null,
            timestamp: new Date().toISOString(),
          });
          context.logger.info("LLDAP directory on {host} is {status}", {
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
        "Deploy or update LLDAP — generates the JWT secret, key seed, and admin bootstrap password on first run (never returned as plaintext)",
      arguments: z.object({}),
      execute: async (_args: unknown, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info("Deploying LLDAP directory to {host}", {
          host: g.nodeHost,
        });
        try {
          const client = await connect(g);
          const so = sudoOpts(g);
          const changes: string[] = [];

          await execSudo(
            client,
            `mkdir -p ${shellEscape(g.deployPath)} ${
              shellEscape(secretsDir(g))
            } ${shellEscape(g.deployPath + "/data")} ${
              shellEscape(userConfigsDir(g))
            } ${shellEscape(groupConfigsDir(g))} ${
              shellEscape(initialPasswordsDir(g))
            }`,
            so,
          );

          // Generate JWT secret / key seed / admin password on-host only if
          // missing — one shared value backs both the main server's
          // LLDAP_LDAP_USER_PASS (env_file) and bootstrap.sh's
          // LLDAP_ADMIN_PASSWORD_FILE, generated once so they can't drift.
          const secretCheck = await execSudo(
            client,
            `[ -f ${
              shellEscape(envFilePath(g))
            } ] && echo EXISTS || echo MISSING`,
            so,
          );
          if (secretCheck.stdout.trim() !== "EXISTS") {
            const gen = await execSudo(
              client,
              `sh -c ${
                shellEscape(
                  `umask 077 && PASS=$(openssl rand -base64 24) && ` +
                    `JWT=$(openssl rand -base64 48) && ` +
                    `SEED=$(openssl rand -base64 48) && ` +
                    `printf 'LLDAP_JWT_SECRET=%s\\nLLDAP_KEY_SEED=%s\\nLLDAP_LDAP_USER_PASS=%s\\n' "$JWT" "$SEED" "$PASS" > ${
                      shellEscape(envFilePath(g))
                    } && ` +
                    `printf '%s' "$PASS" > ${
                      shellEscape(adminPasswordPath(g))
                    } && ` +
                    `chmod 600 ${shellEscape(envFilePath(g))} ${
                      shellEscape(adminPasswordPath(g))
                    }`,
                )
              }`,
              so,
            );
            if (gen.exitCode !== 0) {
              throw new Error(`secret generation failed: ${gen.stderr}`);
            }
            changes.push("generated JWT secret, key seed, and admin password");
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
            "Applied {count} change(s) to LLDAP directory on {host}",
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
    "add-user": {
      description:
        "Create a user (or update displayName/email/groups on an existing one, never touching their password) via LLDAP's own bootstrap.sh. A fresh initial password is generated on-host for new users and never returned — only its on-host path is reported.",
      arguments: z.object({
        username: z.string(),
        email: z.string(),
        displayName: z.string(),
        groups: z.array(z.string()).default([]),
      }),
      execute: async (args: {
        username: string;
        email: string;
        displayName: string;
        groups: string[];
      }, context: MethodContext) => {
        const g = context.globalArgs;
        context.logger.info("Adding user {username} on {host}", {
          username: args.username,
          host: g.nodeHost,
        });
        try {
          const client = await connect(g);
          const so = sudoOpts(g);

          const bootstrapReady = await readRemoteFile(
            client,
            g,
            composePath(g),
          );
          if (bootstrapReady === null) {
            throw new Error(
              "LLDAP isn't deployed on this host yet — run apply first",
            );
          }

          // Live ground-truth check via GraphQL, not swamp-cached state —
          // bootstrap.sh sets the password unconditionally whenever the
          // JSON config includes one, so re-running add-user against an
          // existing user must omit it to avoid silently invalidating a
          // password they've since changed themselves.
          const queryPayload = JSON.stringify({
            query: "query($id: String!) { user(userId: $id) { id } }",
            variables: { id: args.username },
          });
          const queryFile = `${bootstrapDir(g)}/.tmp-user-query.json`;
          await writeFileAs(client, queryFile, queryPayload, so);
          const existsCheck = await execSudo(
            client,
            `sh -c ${
              shellEscape(
                `TOKEN=$(jq -n --arg u ${
                  shellEscape(g.adminUsername)
                } --arg p "$(cat ${
                  shellEscape(adminPasswordPath(g))
                })" '{username:$u,password:$p}' | ` +
                  `curl -s -X POST http://localhost:17170/auth/simple/login -H 'Content-Type: application/json' -d @- | jq -r .token) && ` +
                  `curl -s http://localhost:17170/api/graphql -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data @${
                    shellEscape(`/bootstrap/.tmp-user-query.json`)
                  } | jq -r '.data.user.id // "null"'`,
              )
            }`,
            so,
          );
          await execSudo(client, `rm -f ${shellEscape(queryFile)}`, so);
          const userAlreadyExists = existsCheck.exitCode === 0 &&
            existsCheck.stdout.trim() === args.username;

          let initialPasswordPath: string | null = null;
          const userConfig: Record<string, unknown> = {
            id: args.username,
            email: args.email,
            displayName: args.displayName,
            groups: args.groups,
          };
          if (!userAlreadyExists) {
            userConfig.password = "__INITIAL_PASSWORD_PLACEHOLDER__";
          }
          const userConfigPath = `${userConfigsDir(g)}/${args.username}.json`;
          await writeFileAs(
            client,
            userConfigPath,
            JSON.stringify(userConfig),
            so,
          );

          if (!userAlreadyExists) {
            initialPasswordPath = `${initialPasswordsDir(g)}/${args.username}`;
            const genPassword = await execSudo(
              client,
              `sh -c ${
                shellEscape(
                  `umask 077 && PASS=$(openssl rand -base64 18) && ` +
                    `sed -i "s/__INITIAL_PASSWORD_PLACEHOLDER__/$PASS/" ${
                      shellEscape(userConfigPath)
                    } && ` +
                    `printf '%s' "$PASS" > ${
                      shellEscape(initialPasswordPath)
                    } && ` +
                    `chmod 600 ${shellEscape(initialPasswordPath)}`,
                )
              }`,
              so,
            );
            if (genPassword.exitCode !== 0) {
              throw new Error(
                `initial password generation failed: ${genPassword.stderr}`,
              );
            }
          }

          for (const group of args.groups) {
            await writeFileAs(
              client,
              `${groupConfigsDir(g)}/${group}.json`,
              JSON.stringify({ name: group }),
              so,
            );
          }

          const bootstrap = await execSudo(
            client,
            `docker exec ` +
              `-e LLDAP_ADMIN_PASSWORD_FILE=/secrets/admin_password ` +
              `-e LLDAP_URL=http://localhost:17170 ` +
              `-e USER_CONFIGS_DIR=/bootstrap/user-configs ` +
              `-e GROUP_CONFIGS_DIR=/bootstrap/group-configs ` +
              `lldap /app/bootstrap.sh`,
            so,
          );
          if (bootstrap.exitCode !== 0) {
            throw new Error(`bootstrap.sh failed: ${bootstrap.stderr}`);
          }

          const action: "added" | "updated" = userAlreadyExists
            ? "updated"
            : "added";
          const handle = await context.writeResource("user", args.username, {
            host: g.nodeHost,
            username: args.username,
            action,
            initialPasswordPath,
            error: null,
            timestamp: new Date().toISOString(),
          });
          context.logger.info("User {username} on {host}: {action}", {
            username: args.username,
            host: g.nodeHost,
            action,
          });
          return { dataHandles: [handle] };
        } catch (err) {
          await context.writeResource("user", args.username, {
            host: g.nodeHost,
            username: args.username,
            action: "failed",
            initialPasswordPath: null,
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
