/**
 * Unit tests for the host-ports extension model. Mocks `Deno.Command` via
 * `withMockedCommand` so no real `ss`/`docker` binaries are required.
 *
 * @module
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import {
  model,
  parseDockerPsOutput,
  parseSsOutput,
  sanitizeAddressForName,
} from "./host_ports.ts";

const SS_OUTPUT = [
  "State  Recv-Q Send-Q               Local Address:Port  Peer Address:PortProcess",
  'LISTEN 0      4096                       0.0.0.0:9117       0.0.0.0:*    users:(("docker-proxy",pid=317288,fd=8))',
  'LISTEN 0      4096                     127.0.0.1:8090       0.0.0.0:*    users:(("docker-proxy",pid=1379195,fd=8))',
  "LISTEN 0      128                        0.0.0.0:22         0.0.0.0:*",
  'LISTEN 0      4096                       [::]:9091       [::]:*    users:(("swamp",pid=1530950,fd=12))',
].join("\n");

const DOCKER_OUTPUT = [
  JSON.stringify({
    Names: "jackett",
    Ports: "0.0.0.0:9117->9117/tcp, [::]:9117->9117/tcp",
  }),
  JSON.stringify({
    Names: "shelfarr-admin-shim",
    Ports: "127.0.0.1:8090->8090/tcp",
  }),
  JSON.stringify({
    Names: "gluetun",
    Ports: "8388/tcp",
  }),
].join("\n");

Deno.test("parseSsOutput extracts port, address, and process attribution", () => {
  const ports = parseSsOutput(SS_OUTPUT);
  assertEquals(ports.length, 4);

  assertEquals(ports[0], {
    port: 9117,
    protocol: "tcp",
    address: "0.0.0.0",
    pid: 317288,
    process: "docker-proxy",
  });

  assertEquals(ports[2], {
    port: 22,
    protocol: "tcp",
    address: "0.0.0.0",
    pid: null,
    process: null,
  });

  assertEquals(ports[3], {
    port: 9091,
    protocol: "tcp",
    address: "[::]",
    pid: 1530950,
    process: "swamp",
  });
});

Deno.test("parseDockerPsOutput maps published host ports to container names, skips unpublished", () => {
  const map = parseDockerPsOutput(DOCKER_OUTPUT);
  assertEquals(map.get("tcp:9117"), "jackett");
  assertEquals(map.get("tcp:8090"), "shelfarr-admin-shim");
  assertEquals(map.has("tcp:8388"), false);
});

Deno.test("list_listening_ports correlates ss output with docker containers", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { useSudo: false, includeDocker: true },
  });

  const { result } = await withMockedCommand((cmd, args) => {
    if (cmd === "ss") {
      assertEquals(args, ["-ltnp"]);
      return { stdout: SS_OUTPUT, code: 0 };
    }
    if (cmd === "docker") {
      return { stdout: DOCKER_OUTPUT, code: 0 };
    }
    return { stdout: "", stderr: "unexpected command", code: 1 };
  }, async () => {
    return await model.methods.list_listening_ports.execute(
      {},
      // deno-lint-ignore no-explicit-any
      context as any,
    );
  });

  assertEquals(result.dataHandles.length, 4);
  const written = getWrittenResources();
  const jackett = written.find((w) => w.data.port === 9117);
  assertEquals(jackett?.data.dockerContainer, "jackett");
  const ssh = written.find((w) => w.data.port === 22);
  assertEquals(ssh?.data.dockerContainer, null);
  assertEquals(ssh?.data.pid, null);
});

Deno.test("list_listening_ports uses sudo when useSudo is true", async () => {
  const { context } = createModelTestContext({
    globalArgs: { useSudo: true, includeDocker: false },
  });

  const { calls } = await withMockedCommand((cmd, _args) => {
    if (cmd === "sudo") return { stdout: SS_OUTPUT, code: 0 };
    return { stdout: "", stderr: "unexpected command", code: 1 };
  }, async () => {
    await model.methods.list_listening_ports.execute(
      {},
      // deno-lint-ignore no-explicit-any
      context as any,
    );
  });

  assertEquals(calls[0].command, "sudo");
  assertEquals(calls[0].args, ["ss", "-ltnp"]);
});

Deno.test("list_listening_ports skips docker correlation when includeDocker is false", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { useSudo: false, includeDocker: false },
  });

  const { calls } = await withMockedCommand((cmd, _args) => {
    if (cmd === "ss") return { stdout: SS_OUTPUT, code: 0 };
    return { stdout: "", stderr: "docker should not be called", code: 1 };
  }, async () => {
    await model.methods.list_listening_ports.execute(
      {},
      // deno-lint-ignore no-explicit-any
      context as any,
    );
  });

  assertEquals(calls.length, 1);
  const written = getWrittenResources();
  assertEquals(
    written.every((w) => w.data.dockerContainer === null),
    true,
  );
});

Deno.test("sanitizeAddressForName is stable and filesystem-safe", () => {
  assertEquals(sanitizeAddressForName("0.0.0.0"), "0-0-0-0");
  assertEquals(sanitizeAddressForName("127.0.0.1"), "127-0-0-1");
  assertEquals(sanitizeAddressForName("[::]"), "unspecified");
});

Deno.test("list_listening_ports writes to the same instance name across runs (no sprawl)", async () => {
  const { context: context1, getWrittenResources: written1 } =
    createModelTestContext({
      globalArgs: { useSudo: false, includeDocker: false },
    });

  await withMockedCommand(
    () => ({ stdout: SS_OUTPUT, code: 0 }),
    () =>
      model.methods.list_listening_ports.execute(
        {},
        // deno-lint-ignore no-explicit-any
        context1 as any,
      ),
  );

  const { context: context2, getWrittenResources: written2 } =
    createModelTestContext({
      globalArgs: { useSudo: false, includeDocker: false },
    });

  await withMockedCommand(
    () => ({ stdout: SS_OUTPUT, code: 0 }),
    () =>
      model.methods.list_listening_ports.execute(
        {},
        // deno-lint-ignore no-explicit-any
        context2 as any,
      ),
  );

  const names1 = written1().map((w) => w.name).sort();
  const names2 = written2().map((w) => w.name).sort();
  assertEquals(names1, names2);
});

Deno.test("list_listening_ports throws descriptively when ss fails", async () => {
  const { context } = createModelTestContext({
    globalArgs: { useSudo: false, includeDocker: false },
  });

  await withMockedCommand(
    () => ({ stdout: "", stderr: "ss: command not found", code: 127 }),
    async () => {
      await assertRejects(
        () =>
          model.methods.list_listening_ports.execute(
            {},
            // deno-lint-ignore no-explicit-any
            context as any,
          ),
        Error,
        "ss",
      );
    },
  );
});

Deno.test("list_listening_ports degrades gracefully when docker is unavailable", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { useSudo: false, includeDocker: true },
  });

  await withMockedCommand((cmd) => {
    if (cmd === "ss") return { stdout: SS_OUTPUT, code: 0 };
    throw new Error("docker: command not found");
  }, async () => {
    await model.methods.list_listening_ports.execute(
      {},
      // deno-lint-ignore no-explicit-any
      context as any,
    );
  });

  const written = getWrittenResources();
  assertEquals(written.length, 4);
  assertEquals(
    written.every((w) => w.data.dockerContainer === null),
    true,
  );
});
