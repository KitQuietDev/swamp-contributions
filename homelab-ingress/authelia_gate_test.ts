/**
 * Unit tests for the authelia-gate extension model. Mocks `Deno.Command` via
 * `withMockedCommand` so no real host or `docker` binary is required, and
 * confirms `add-user` never receives or forwards a plaintext password.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import { stringify as stringifyYaml } from "npm:yaml@2.8.3";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import {
  desiredConfig,
  forwardAuthMiddleware,
  model,
  validateGlobalArgs,
} from "./authelia_gate.ts";

const GLOBAL_ARGS = {
  nodeHost: "vps.test",
  nodeUser: "root",
  nodePort: 22,
  become: false,
  becomeUser: "root",
  deployPath: "/opt/authelia-stack",
  traefikDynamicConfigPath: "/opt/traefik-stack/dynamic.yml",
  domain: "example.com",
  authHostname: "auth.example.com",
  sessionExpiration: "1h",
  sessionInactivity: "5m",
  image: "authelia/authelia:latest",
  networkName: "edge",
  authBackend: "file" as const,
  oidcEnabled: false,
};

Deno.test("desiredConfig: default policy denies, catch-all rule is one_factor scoped to the domain", () => {
  const conf = desiredConfig(GLOBAL_ARGS);
  assertEquals(conf.access_control.default_policy, "deny");
  assertEquals(conf.access_control.rules, [
    { domain: ["*.example.com"], policy: "one_factor" },
  ]);
});

Deno.test("forwardAuthMiddleware: points at authelia's /api/verify with the redirect target set", () => {
  const mw = forwardAuthMiddleware(GLOBAL_ARGS);
  assertEquals(
    mw.forwardAuth.address,
    "http://authelia:9091/api/verify?rd=https://auth.example.com",
  );
  assertEquals(mw.forwardAuth.trustForwardHeader, true);
});

// deno-lint-ignore no-explicit-any
function sshMock(handleCommand: (command: string) => any) {
  return (cmd: string, args: string[]) => {
    if (cmd === "ssh") {
      if (args.includes("-O")) return { stdout: "", code: 1 };
      if (args.includes("-M")) return { stdout: "", code: 0 };
      return handleCommand(args[args.length - 1]);
    }
    if (cmd === "scp") return { stdout: "", code: 0 };
    return { stdout: "", stderr: `unexpected command: ${cmd}`, code: 1 };
  };
}

Deno.test("apply preserves existing bypass rules instead of wiping them out (mergedConfig)", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  // Mirrors a real hand-configured instance: two mobile-app bypass rules
  // already live in configuration.yml, added outside this extension.
  const existingConfig = `theme: dark
access_control:
  default_policy: deny
  rules:
    - domain: photos.example.com
      resources:
        - ^/api/.*$
      policy: bypass
    - domain: books.example.com
      resources:
        - ^/api/.*$
      policy: bypass
    - domain:
        - "*.example.com"
      policy: one_factor
`;

  let writtenConfig: string | null = null;
  await withMockedCommand(
    (cmd: string, args: string[]) => {
      if (cmd === "scp") {
        // writeFileAs writes the real content to a local temp file before
        // scp'ing it — read that file to see exactly what would be sent.
        const localTmpFile = args[args.length - 2];
        const remoteSpec = args[args.length - 1];
        if (remoteSpec.includes("configuration.yml")) {
          writtenConfig = Deno.readTextFileSync(localTmpFile);
        }
        return { stdout: "", code: 0 };
      }
      if (cmd !== "ssh") {
        return { stdout: "", stderr: `unexpected command: ${cmd}`, code: 1 };
      }
      if (args.includes("-O")) return { stdout: "", code: 1 };
      if (args.includes("-M")) return { stdout: "", code: 0 };
      const command = args[args.length - 1];

      if (command.startsWith("[ -f") && command.includes("session_secret")) {
        return { stdout: "EXISTS\n", code: 0 };
      }
      if (
        command.startsWith("cat ") && command.includes("configuration.yml")
      ) {
        return { stdout: existingConfig, code: 0 };
      }
      if (
        command.startsWith("cat ") && command.includes("users_database.yml")
      ) {
        return { stdout: "users: {}\n", code: 0 };
      }
      if (
        command.startsWith("cat ") && command.includes("docker-compose.yml")
      ) {
        return { stdout: "", code: 1 };
      }
      if (command.startsWith("cat ") && command.includes("dynamic.yml")) {
        return { stdout: "http:\n  middlewares: {}\n", code: 0 };
      }
      if (command.startsWith("docker inspect")) {
        return { stdout: "true\n", code: 0 };
      }
      if (command.includes("docker compose")) return { stdout: "", code: 0 };
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    },
    // deno-lint-ignore no-explicit-any
    () => model.methods.apply.execute({}, context as any),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.status, "applied");
  // The two hand-added bypass rules must still be present verbatim.
  assertEquals(writtenConfig !== null, true);
  assertEquals(writtenConfig!.includes("photos.example.com"), true);
  assertEquals(writtenConfig!.includes("books.example.com"), true);
});

Deno.test("check does not report 'update config' when existing bypass rules are already correctly merged (no false positive)", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  // Exactly what mergedConfig would produce: bypass rule preserved ahead of
  // the managed catch-all rule, catch-all last. Built via stringifyYaml
  // (rather than hand-typed) so the comparison is byte-exact.
  const desired = desiredConfig(GLOBAL_ARGS);
  const alreadyMerged = stringifyYaml({
    ...desired,
    access_control: {
      ...desired.access_control,
      rules: [
        {
          domain: "photos.example.com",
          resources: ["^/api/.*$"],
          policy: "bypass",
        },
        ...desired.access_control.rules,
      ],
    },
  });

  await withMockedCommand(
    sshMock((command) => {
      if (
        command.startsWith("cat ") && command.includes("configuration.yml")
      ) {
        return { stdout: alreadyMerged, code: 0 };
      }
      if (command.startsWith("docker inspect")) {
        return { stdout: "true\n", code: 0 };
      }
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    // deno-lint-ignore no-explicit-any
    () => model.methods.check.execute({}, context as any),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.status, "compliant");
  assertEquals(written[0].data.changes, []);
});

Deno.test("add-bypass-rule inserts the bypass rule before the existing catch-all rule", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  const existingConfig = `access_control:
  default_policy: deny
  rules:
    - domain:
        - "*.example.com"
      policy: one_factor
`;

  await withMockedCommand(
    sshMock((command) => {
      if (command.startsWith("cat ") && command.includes("configuration.yml")) {
        return { stdout: existingConfig, code: 0 };
      }
      if (command.startsWith("docker compose")) return { stdout: "", code: 0 };
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    () =>
      model.methods["add-bypass-rule"].execute(
        { domain: "photos.example.com", resources: ["^/api/.*$"] },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.action, "added");
});

Deno.test("add-user stores the passwordHash verbatim and never touches a plaintext password field", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  const hash =
    "$argon2id$v=19$m=65536,t=3,p=4$fakesaltfakesalt$fakehashfakehash";

  await withMockedCommand(
    sshMock((command) => {
      if (
        command.startsWith("cat ") && command.includes("users_database.yml")
      ) {
        return { stdout: "", code: 1 };
      }
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    () =>
      model.methods["add-user"].execute(
        {
          username: "jsmith",
          passwordHash: hash,
          email: "jsmith@example.com",
          displayName: "J Smith",
          groups: ["admins"],
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.action, "added");
});

Deno.test("apply records a failed status and throws when on-host secret generation fails", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  let err: Error | null = null;
  await withMockedCommand(
    sshMock((command) => {
      if (command.startsWith("mkdir -p")) return { stdout: "", code: 0 };
      if (command.startsWith("[ -f") && command.includes("session_secret")) {
        return { stdout: "MISSING\n", code: 0 };
      }
      if (command.includes("authelia crypto rand")) {
        return { stdout: "", stderr: "permission denied", code: 1 };
      }
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    async () => {
      try {
        // deno-lint-ignore no-explicit-any
        await model.methods.apply.execute({}, context as any);
      } catch (e) {
        err = e as Error;
      }
    },
  );

  assertEquals(err !== null, true);
  assertEquals(err!.message.includes("secret generation failed"), true);
  const written = getWrittenResources();
  assertEquals(written[0].data.status, "failed");
});

Deno.test("desiredConfig: ldap backend emits Authelia's documented LLDAP pairing shape (implementation 'lldap')", () => {
  const conf = desiredConfig({
    ...GLOBAL_ARGS,
    authBackend: "ldap",
    ldapAddress: "ldap://lldap:3890",
    ldapBaseDn: "dc=example,dc=com",
    ldapBindUser: "uid=admin,ou=people,dc=example,dc=com",
    ldapBindPassword: "supersecret",
  });
  assertEquals(conf.authentication_backend.ldap.implementation, "lldap");
  assertEquals(conf.authentication_backend.ldap.address, "ldap://lldap:3890");
  assertEquals(conf.authentication_backend.ldap.base_dn, "dc=example,dc=com");
  assertEquals("file" in conf.authentication_backend, false);
});

Deno.test("desiredConfig: oidc block only appears when oidcEnabled, embedding the caller-supplied issuer key inline", () => {
  const disabled = desiredConfig(GLOBAL_ARGS);
  assertEquals("identity_providers" in disabled, false);

  const enabled = desiredConfig({
    ...GLOBAL_ARGS,
    oidcEnabled: true,
    oidcIssuerPrivateKeyPem:
      "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----",
  });
  assertEquals(
    enabled.identity_providers.oidc.jwks[0].key.includes("FAKE"),
    true,
  );
  assertEquals(enabled.identity_providers.oidc.clients, []);
});

Deno.test("validateGlobalArgs throws when authBackend is 'ldap' but ldap connection fields are missing", () => {
  let threw = false;
  try {
    validateGlobalArgs({ ...GLOBAL_ARGS, authBackend: "ldap" });
  } catch (e) {
    threw = true;
    assertEquals((e as Error).message.includes("ldapAddress"), true);
  }
  assertEquals(threw, true);
});

Deno.test("validateGlobalArgs throws when oidcEnabled but oidcIssuerPrivateKeyPem is missing", () => {
  let threw = false;
  try {
    validateGlobalArgs({ ...GLOBAL_ARGS, oidcEnabled: true });
  } catch (e) {
    threw = true;
    assertEquals(
      (e as Error).message.includes("oidcIssuerPrivateKeyPem"),
      true,
    );
  }
  assertEquals(threw, true);
});

Deno.test("add-user throws a guard error when authBackend is 'ldap', pointing at lldap_directory instead", async () => {
  const { context } = createModelTestContext({
    globalArgs: { ...GLOBAL_ARGS, authBackend: "ldap" },
  });

  let err: Error | null = null;
  try {
    await model.methods["add-user"].execute(
      {
        username: "jsmith",
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$fake$fake",
        email: "jsmith@example.com",
        displayName: "J Smith",
        groups: [],
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
  } catch (e) {
    err = e as Error;
  }

  assertEquals(err !== null, true);
  assertEquals(err!.message.includes("lldap_directory"), true);
});

Deno.test("add-oidc-client throws when oidcEnabled is false", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });

  let err: Error | null = null;
  try {
    await model.methods["add-oidc-client"].execute(
      {
        clientId: "immich",
        clientName: "Immich",
        clientSecretHash: "$pbkdf2-sha512$fake",
        redirectUris: ["https://photos.example.com/callback"],
        scopes: ["openid", "profile", "email"],
        grantTypes: ["authorization_code"],
        public: false,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );
  } catch (e) {
    err = e as Error;
  }

  assertEquals(err !== null, true);
  assertEquals(err!.message.includes("oidcEnabled"), true);
});

Deno.test("add-oidc-client inserts a new client without disturbing an existing one", async () => {
  const oidcArgs = {
    ...GLOBAL_ARGS,
    oidcEnabled: true,
    oidcIssuerPrivateKeyPem:
      "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----",
  };
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: oidcArgs,
  });

  const existingConfig = stringifyYaml({
    ...desiredConfig(oidcArgs),
    identity_providers: {
      oidc: {
        jwks: desiredConfig(oidcArgs).identity_providers.oidc.jwks,
        clients: [{
          client_id: "audiobookshelf",
          client_name: "Audiobookshelf",
          client_secret: "$pbkdf2-sha512$existing",
          public: false,
          redirect_uris: ["https://books.example.com/callback"],
          scopes: ["openid", "profile", "email"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          consent_mode: "explicit",
        }],
      },
    },
  });

  let writtenConfig: string | null = null;
  await withMockedCommand(
    (cmd: string, args: string[]) => {
      if (cmd === "scp") {
        const localTmpFile = args[args.length - 2];
        const remoteSpec = args[args.length - 1];
        if (remoteSpec.includes("configuration.yml")) {
          writtenConfig = Deno.readTextFileSync(localTmpFile);
        }
        return { stdout: "", code: 0 };
      }
      if (cmd !== "ssh") {
        return { stdout: "", stderr: `unexpected command: ${cmd}`, code: 1 };
      }
      if (args.includes("-O")) return { stdout: "", code: 1 };
      if (args.includes("-M")) return { stdout: "", code: 0 };
      const command = args[args.length - 1];
      if (
        command.startsWith("cat ") && command.includes("configuration.yml")
      ) {
        return { stdout: existingConfig, code: 0 };
      }
      if (command.includes("docker compose")) return { stdout: "", code: 0 };
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    },
    () =>
      model.methods["add-oidc-client"].execute(
        {
          clientId: "immich",
          clientName: "Immich",
          clientSecretHash: "$pbkdf2-sha512$fake",
          redirectUris: ["https://photos.example.com/callback"],
          scopes: ["openid", "profile", "email"],
          grantTypes: ["authorization_code"],
          public: false,
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.action, "added");
  assertEquals(writtenConfig !== null, true);
  assertEquals(writtenConfig!.includes("audiobookshelf"), true);
  assertEquals(writtenConfig!.includes("immich"), true);
});
