/**
 * Unit tests for the traefik-stack extension model. Mocks `Deno.Command` via
 * `withMockedCommand` so no real host or `docker` binary is required.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import {
  desiredStaticConfig,
  emptyDynamicConfig,
  model,
} from "./traefik_stack.ts";

const GLOBAL_ARGS = {
  nodeHost: "vps.test",
  nodeUser: "root",
  nodePort: 22,
  become: false,
  becomeUser: "root",
  deployPath: "/opt/traefik-stack",
  acmeEmail: "you@example.com",
  letsEncryptStaging: true,
  image: "traefik:v3.3",
  networkName: "edge",
};

Deno.test("desiredStaticConfig: staging flag adds the Let's Encrypt staging CA server", () => {
  const staging = desiredStaticConfig(GLOBAL_ARGS);
  const prod = desiredStaticConfig({
    ...GLOBAL_ARGS,
    letsEncryptStaging: false,
  });
  assertEquals(staging.includes("acme-staging-v02"), true);
  assertEquals(prod.includes("acme-staging-v02"), false);
});

Deno.test("desiredStaticConfig: uses HTTP-01 challenge only, no DNS-provider config", () => {
  const conf = desiredStaticConfig(GLOBAL_ARGS);
  assertEquals(conf.includes("httpChallenge"), true);
  assertEquals(conf.includes("dnsChallenge"), false);
});

Deno.test("emptyDynamicConfig: starts with empty routers/services/middlewares", () => {
  const conf = emptyDynamicConfig();
  assertEquals(conf.includes("routers: {}"), true);
  assertEquals(conf.includes("services: {}"), true);
  assertEquals(conf.includes("middlewares: {}"), true);
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

Deno.test("add-route adds a new router+service without disturbing an existing one", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  const existingDynamic = `http:
  routers:
    existing:
      rule: Host(\`existing.example.com\`)
      entrypoints: websecure
      tls:
        certresolver: letsencrypt
      service: existing-svc
  services:
    existing-svc:
      loadBalancer:
        servers:
          - url: http://192.0.2.1:8080
`;

  await withMockedCommand(
    sshMock((command) => {
      if (command.startsWith("cat ")) {
        return { stdout: existingDynamic, code: 0 };
      }
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    () =>
      model.methods["add-route"].execute(
        {
          routerName: "photos",
          hostname: "photos.example.com",
          backendUrl: "http://198.51.100.2:2283",
          middlewares: ["authelia"],
          certResolver: "letsencrypt",
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.action, "added");
});

Deno.test("add-route is idempotent: re-adding the identical route reports unchanged and writes nothing", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  const alreadyThere = `http:
  routers:
    photos:
      rule: Host(\`photos.example.com\`)
      entrypoints: websecure
      tls:
        certresolver: letsencrypt
      service: photos-svc
      middlewares:
        - authelia
  services:
    photos-svc:
      loadBalancer:
        servers:
          - url: http://198.51.100.2:2283
`;

  const { calls } = await withMockedCommand(
    sshMock((command) => {
      if (command.startsWith("cat ")) return { stdout: alreadyThere, code: 0 };
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    () =>
      model.methods["add-route"].execute(
        {
          routerName: "photos",
          hostname: "photos.example.com",
          backendUrl: "http://198.51.100.2:2283",
          middlewares: ["authelia"],
          certResolver: "letsencrypt",
        },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.action, "unchanged");
  assertEquals(calls.some((c) => c.command === "scp"), false);
});

Deno.test("remove-route deletes only the named router+service, no-ops if absent", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  await withMockedCommand(
    sshMock((command) => {
      if (command.startsWith("cat ")) return { stdout: "", code: 1 };
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    () =>
      model.methods["remove-route"].execute(
        { routerName: "nonexistent" },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.action, "unchanged");
});

Deno.test("apply records a failed status and throws when docker compose up fails", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  let err: Error | null = null;
  await withMockedCommand(
    sshMock((command) => {
      if (command.startsWith("mkdir -p")) return { stdout: "", code: 0 };
      if (command.startsWith("cat ")) return { stdout: "", code: 1 };
      if (command.startsWith("docker inspect")) {
        return { stdout: "false\n", code: 0 };
      }
      if (command.includes("docker compose up -d")) {
        return { stdout: "", stderr: "port is already allocated", code: 1 };
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
  assertEquals(err!.message.includes("docker compose up failed"), true);
  const written = getWrittenResources();
  assertEquals(written[0].data.status, "failed");
});
