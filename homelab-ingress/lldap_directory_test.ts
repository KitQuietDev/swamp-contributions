/**
 * Unit tests for the lldap-directory extension model. Mocks `Deno.Command`
 * via `withMockedCommand` so no real host or `docker`/`openssl` binary is
 * required.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { desiredComposeFile, model } from "./lldap_directory.ts";

const GLOBAL_ARGS = {
  nodeHost: "vps.test",
  nodeUser: "root",
  nodePort: 22,
  become: false,
  becomeUser: "root",
  deployPath: "/opt/lldap-stack",
  image: "lldap/lldap:stable",
  ldapBaseDn: "dc=example,dc=com",
  adminUsername: "admin",
  networkName: "edge",
};

Deno.test("desiredComposeFile: references the generated env file and the configured base DN, publishes no host ports", () => {
  const compose = desiredComposeFile(GLOBAL_ARGS);
  assertEquals(compose.includes("./secrets/lldap.env"), true);
  assertEquals(compose.includes("dc=example,dc=com"), true);
  assertEquals(compose.includes("edge"), true);
  assertEquals(compose.includes("ports:"), false);
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

Deno.test("apply deploys LLDAP fresh: generates secrets, writes compose, starts the stack", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  let upRan = false;
  await withMockedCommand(
    sshMock((command) => {
      if (command.startsWith("mkdir -p")) return { stdout: "", code: 0 };
      if (
        command.startsWith("[ -f") && command.includes("lldap.env")
      ) {
        return { stdout: "MISSING\n", code: 0 };
      }
      if (command.startsWith("sh -c") && command.includes("LLDAP_JWT_SECRET")) {
        return { stdout: "", code: 0 };
      }
      if (
        command.startsWith("cat ") && command.includes("docker-compose.yml")
      ) {
        return { stdout: "", code: 1 };
      }
      if (command.includes("docker compose up -d")) {
        upRan = true;
        return { stdout: "", code: 0 };
      }
      if (command.startsWith("docker inspect")) {
        return upRan ? { stdout: "true\n", code: 0 } : { stdout: "", code: 1 };
      }
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    // deno-lint-ignore no-explicit-any
    () => model.methods.apply.execute({}, context as any),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.status, "applied");
  assertEquals(written[0].data.running, true);
  assertEquals(
    (written[0].data.changes as string[]).includes(
      "generated JWT secret, key seed, and admin password",
    ),
    true,
  );
});

Deno.test("apply is a no-op when secrets/compose already match and the stack is already running", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  await withMockedCommand(
    sshMock((command) => {
      if (command.startsWith("mkdir -p")) return { stdout: "", code: 0 };
      if (
        command.startsWith("[ -f") && command.includes("lldap.env")
      ) {
        return { stdout: "EXISTS\n", code: 0 };
      }
      if (
        command.startsWith("cat ") && command.includes("docker-compose.yml")
      ) {
        return { stdout: desiredComposeFile(GLOBAL_ARGS), code: 0 };
      }
      if (command.startsWith("docker inspect")) {
        return { stdout: "true\n", code: 0 };
      }
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    // deno-lint-ignore no-explicit-any
    () => model.methods.apply.execute({}, context as any),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.status, "compliant");
  assertEquals(written[0].data.changes, []);
});

Deno.test("apply records a failed status and throws when on-host secret generation fails", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  let err: Error | null = null;
  await withMockedCommand(
    sshMock((command) => {
      if (command.startsWith("mkdir -p")) return { stdout: "", code: 0 };
      if (
        command.startsWith("[ -f") && command.includes("lldap.env")
      ) {
        return { stdout: "MISSING\n", code: 0 };
      }
      if (command.startsWith("sh -c") && command.includes("LLDAP_JWT_SECRET")) {
        return { stdout: "", stderr: "openssl: command not found", code: 127 };
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

Deno.test("add-user creates a new user with a fresh on-host initial password, never returned to us", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  let capturedUserConfig: string | null = null;
  await withMockedCommand(
    (cmd: string, args: string[]) => {
      if (cmd === "ssh") {
        if (args.includes("-O")) return { stdout: "", code: 1 };
        if (args.includes("-M")) return { stdout: "", code: 0 };
        const command = args[args.length - 1];
        if (
          command.startsWith("cat ") && command.includes("docker-compose.yml")
        ) {
          return { stdout: desiredComposeFile(GLOBAL_ARGS), code: 0 };
        }
        if (command.startsWith("sh -c") && command.includes("graphql")) {
          // No existing user — GraphQL query returns null.
          return { stdout: "null\n", code: 0 };
        }
        if (command.startsWith("rm -f")) return { stdout: "", code: 0 };
        if (
          command.startsWith("sh -c") &&
          command.includes("INITIAL_PASSWORD_PLACEHOLDER")
        ) {
          return { stdout: "", code: 0 };
        }
        if (
          command.startsWith("docker exec") &&
          command.includes("bootstrap.sh")
        ) {
          return { stdout: "created user jsmith\n", code: 0 };
        }
        return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
      }
      if (cmd === "scp") {
        const localTmpFile = args[args.length - 2];
        const remoteSpec = args[args.length - 1];
        if (remoteSpec.includes("user-configs/jsmith.json")) {
          capturedUserConfig = Deno.readTextFileSync(localTmpFile);
        }
        return { stdout: "", code: 0 };
      }
      return { stdout: "", stderr: `unexpected command: ${cmd}`, code: 1 };
    },
    () =>
      model.methods["add-user"].execute(
        {
          username: "jsmith",
          email: "jsmith@example.com",
          displayName: "J Smith",
          groups: ["family"],
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.action, "added");
  assertEquals(
    written[0].data.initialPasswordPath,
    "/opt/lldap-stack/secrets/initial-passwords/jsmith",
  );
  assertEquals(capturedUserConfig !== null, true);
  assertEquals(
    capturedUserConfig!.includes("__INITIAL_PASSWORD_PLACEHOLDER__"),
    true,
  );
});

Deno.test("add-user updates an existing user without touching their password (no password field written)", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  let capturedUserConfig: string | null = null;
  await withMockedCommand(
    (cmd: string, args: string[]) => {
      if (cmd === "ssh") {
        if (args.includes("-O")) return { stdout: "", code: 1 };
        if (args.includes("-M")) return { stdout: "", code: 0 };
        const command = args[args.length - 1];
        if (
          command.startsWith("cat ") && command.includes("docker-compose.yml")
        ) {
          return { stdout: desiredComposeFile(GLOBAL_ARGS), code: 0 };
        }
        if (command.startsWith("sh -c") && command.includes("graphql")) {
          // Existing user — GraphQL query echoes the username back.
          return { stdout: "jsmith\n", code: 0 };
        }
        if (command.startsWith("rm -f")) return { stdout: "", code: 0 };
        if (
          command.startsWith("docker exec") &&
          command.includes("bootstrap.sh")
        ) {
          return { stdout: "updated user jsmith\n", code: 0 };
        }
        return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
      }
      if (cmd === "scp") {
        const localTmpFile = args[args.length - 2];
        const remoteSpec = args[args.length - 1];
        if (remoteSpec.includes("user-configs/jsmith.json")) {
          capturedUserConfig = Deno.readTextFileSync(localTmpFile);
        }
        return { stdout: "", code: 0 };
      }
      return { stdout: "", stderr: `unexpected command: ${cmd}`, code: 1 };
    },
    () =>
      model.methods["add-user"].execute(
        {
          username: "jsmith",
          email: "jsmith@example.com",
          displayName: "J Smith (updated)",
          groups: ["family"],
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.action, "updated");
  assertEquals(written[0].data.initialPasswordPath, null);
  assertEquals(capturedUserConfig !== null, true);
  assertEquals(capturedUserConfig!.includes("password"), false);
});

Deno.test("add-user records a failed status and throws when bootstrap.sh fails", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  let err: Error | null = null;
  await withMockedCommand(
    sshMock((command) => {
      if (
        command.startsWith("cat ") && command.includes("docker-compose.yml")
      ) {
        return { stdout: desiredComposeFile(GLOBAL_ARGS), code: 0 };
      }
      if (command.startsWith("sh -c") && command.includes("graphql")) {
        return { stdout: "null\n", code: 0 };
      }
      if (command.startsWith("rm -f")) return { stdout: "", code: 0 };
      if (
        command.startsWith("sh -c") &&
        command.includes("INITIAL_PASSWORD_PLACEHOLDER")
      ) {
        return { stdout: "", code: 0 };
      }
      if (
        command.startsWith("docker exec") && command.includes("bootstrap.sh")
      ) {
        return { stdout: "", stderr: "connection refused", code: 1 };
      }
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    async () => {
      try {
        await model.methods["add-user"].execute(
          {
            username: "jsmith",
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
    },
  );

  assertEquals(err !== null, true);
  assertEquals(err!.message.includes("bootstrap.sh failed"), true);
  const written = getWrittenResources();
  assertEquals(written[0].data.action, "failed");
});
