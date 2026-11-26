/**
 * Unit tests for the wireguard-tunnel extension model. Mocks `Deno.Command`
 * via `withMockedCommand` so no real host or `wg` binary is required, and
 * confirms the private key never appears in any mocked command's captured
 * output.
 *
 * @module
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { expectedLines, model, parseWgShow } from "./wireguard_tunnel.ts";

const SERVER_ARGS = {
  nodeHost: "vps.test",
  nodeUser: "root",
  nodePort: 22,
  become: false,
  becomeUser: "root",
  interfaceName: "wg0",
  role: "server" as const,
  tunnelAddress: "198.51.100.1/24",
  listenPort: 51820,
  peerPublicKey: "peerPUBKEY=",
  peerAllowedIPs: "198.51.100.2/32",
};

const CLIENT_ARGS = {
  nodeHost: "homelab.test",
  nodeUser: "root",
  nodePort: 22,
  become: false,
  becomeUser: "root",
  interfaceName: "wg0",
  role: "client" as const,
  tunnelAddress: "198.51.100.2/24",
  peerPublicKey: "peerPUBKEY=",
  peerEndpoint: "vps.test:51820",
  peerAllowedIPs: "198.51.100.1/32",
  persistentKeepalive: 25,
};

Deno.test("parseWgShow: empty output means the interface is down", () => {
  assertEquals(parseWgShow(""), {
    up: false,
    publicKey: null,
    listenPort: null,
    lastHandshakeAgeSeconds: null,
  });
});

Deno.test("parseWgShow: extracts public key, listening port, and 'Now' handshake as 0 seconds", () => {
  const parsed = parseWgShow(
    "interface: wg0\n  public key: abcPUBKEY=\n  listening port: 51820\n\npeer: xyz\n  latest handshake: Now\n",
  );
  assertEquals(parsed.up, true);
  assertEquals(parsed.publicKey, "abcPUBKEY=");
  assertEquals(parsed.listenPort, 51820);
  assertEquals(parsed.lastHandshakeAgeSeconds, 0);
});

Deno.test("parseWgShow: parses compound relative handshake time ('3 minutes, 10 seconds ago')", () => {
  const parsed = parseWgShow(
    "peer: xyz\n  latest handshake: 3 minutes, 10 seconds ago\n",
  );
  assertEquals(parsed.lastHandshakeAgeSeconds, 190);
});

Deno.test("expectedLines: server role includes ListenPort, not Endpoint", () => {
  const lines = expectedLines(SERVER_ARGS);
  assertEquals(lines.includes("ListenPort = 51820"), true);
  assertEquals(lines.some((l) => l.startsWith("Endpoint")), false);
  assertEquals(lines.some((l) => l.startsWith("PrivateKey")), false);
});

Deno.test("expectedLines: client role includes Endpoint and PersistentKeepalive, not ListenPort", () => {
  const lines = expectedLines(CLIENT_ARGS);
  assertEquals(lines.includes("Endpoint = vps.test:51820"), true);
  assertEquals(lines.includes("PersistentKeepalive = 25"), true);
  assertEquals(lines.some((l) => l.startsWith("ListenPort")), false);
});

const FAKE_PUBKEY = "generatedPUBKEY=";

function makeWgSshMock() {
  let confWritten = false;
  // deno-lint-ignore no-explicit-any
  return (cmd: string, args: string[]): any => {
    if (cmd !== "ssh") {
      return { stdout: "", stderr: `unexpected command: ${cmd}`, code: 1 };
    }
    if (args.includes("-O")) return { stdout: "", code: 1 };
    if (args.includes("-M")) return { stdout: "", code: 0 };
    const command = args[args.length - 1];

    if (command.startsWith("wg show")) {
      if (!confWritten) return { stdout: "", code: 0 };
      return {
        stdout:
          `interface: wg0\n  public key: ${FAKE_PUBKEY}\n  listening port: 51820\n\npeer: x\n  latest handshake: 5 seconds ago\n`,
        code: 0,
      };
    }
    if (command.startsWith("test -f")) {
      return { stdout: confWritten ? "EXISTS\n" : "MISSING\n", code: 0 };
    }
    if (command.startsWith("grep -qF")) {
      return { stdout: confWritten ? "OK\n" : "MISSING\n", code: 0 };
    }
    if (command === "which wg wg-quick") return { stdout: "", code: 0 };
    if (command.includes("wg genkey")) {
      return { stdout: "GENERATED\n", code: 0 };
    }
    if (command.startsWith("cat ") && command.includes("_publickey")) {
      return { stdout: FAKE_PUBKEY + "\n", code: 0 };
    }
    if (command.includes("WGEOF")) {
      confWritten = true;
      return { stdout: "WRITTEN\n", code: 0 };
    }
    if (command.startsWith("systemctl enable --now")) {
      return { stdout: "", code: 0 };
    }
    if (command.startsWith("systemctl restart")) {
      return { stdout: "", code: 0 };
    }
    return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
  };
}

Deno.test("check reports non_compliant with a fresh host: needs a config file and the interface brought up", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: SERVER_ARGS,
  });

  await withMockedCommand(
    makeWgSshMock(),
    // deno-lint-ignore no-explicit-any
    () => model.methods.check.execute({}, context as any),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.status, "non_compliant");
  const changes = written[0].data.changes as string[];
  assertEquals(changes.includes("create config file"), true);
  assertEquals(changes.includes("bring interface up"), true);
});

Deno.test("apply generates a keypair on-host and never returns the private key in any written resource", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: SERVER_ARGS,
  });

  const { calls } = await withMockedCommand(
    makeWgSshMock(),
    // deno-lint-ignore no-explicit-any
    () => model.methods.apply.execute({}, context as any),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.status, "applied");
  assertEquals(written[0].data.publicKey, FAKE_PUBKEY);

  // The private key must never transit back through any captured exec call.
  const allCapturedText = JSON.stringify(calls) + JSON.stringify(written);
  assertStringIncludes(allCapturedText, "wg genkey");
  assertEquals(allCapturedText.includes("PrivateKey = wg"), false);
});

Deno.test("rotate-key reports the real post-rotation handshake age, not a hardcoded null", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: SERVER_ARGS,
  });

  await withMockedCommand(
    // deno-lint-ignore no-explicit-any
    (cmd: string, args: string[]): any => {
      if (cmd !== "ssh") {
        return { stdout: "", stderr: `unexpected command: ${cmd}`, code: 1 };
      }
      if (args.includes("-O")) return { stdout: "", code: 1 };
      if (args.includes("-M")) return { stdout: "", code: 0 };
      const command = args[args.length - 1];

      if (command.includes("wg genkey")) return { stdout: "DONE\n", code: 0 };
      if (command.startsWith("cat ") && command.includes("_publickey")) {
        return { stdout: FAKE_PUBKEY + "\n", code: 0 };
      }
      if (command.startsWith("wg show")) {
        return {
          stdout:
            `interface: wg0\n  public key: ${FAKE_PUBKEY}\n  listening port: 51820\n\npeer: x\n  latest handshake: 12 seconds ago\n`,
          code: 0,
        };
      }
      if (command.startsWith("test -f")) return { stdout: "EXISTS\n", code: 0 };
      if (command.startsWith("grep -qF")) return { stdout: "OK\n", code: 0 };
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    },
    // deno-lint-ignore no-explicit-any
    () => model.methods["rotate-key"].execute({}, context as any),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.status, "applied");
  assertEquals(written[0].data.lastHandshakeAgeSeconds, 12);
});

Deno.test("apply records a failed status and throws descriptively when the wireguard package install fails", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: SERVER_ARGS,
  });

  let err: Error | null = null;
  await withMockedCommand(
    // deno-lint-ignore no-explicit-any
    (cmd: string, args: string[]): any => {
      if (cmd !== "ssh") {
        return { stdout: "", stderr: `unexpected command: ${cmd}`, code: 1 };
      }
      if (args.includes("-O")) return { stdout: "", code: 1 };
      if (args.includes("-M")) return { stdout: "", code: 0 };
      const command = args[args.length - 1];
      if (command === "which wg wg-quick") return { stdout: "", code: 1 };
      if (command.includes("apt-get install")) {
        return {
          stdout: "",
          stderr: "Unable to locate package wireguard",
          code: 100,
        };
      }
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    },
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
  assertEquals(err!.message.includes("wireguard install failed"), true);
  const written = getWrittenResources();
  assertEquals(written[0].data.status, "failed");
});
