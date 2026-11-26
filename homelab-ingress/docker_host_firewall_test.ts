/**
 * Unit tests for the docker-host-firewall extension model. Mocks
 * `Deno.Command` via `withMockedCommand` so no real host or `nft` binary is
 * required.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { model, requiredRules } from "./docker_host_firewall.ts";

const GLOBAL_ARGS = {
  nodeHost: "vps.test",
  nodeUser: "root",
  nodePort: 22,
  become: false,
  becomeUser: "root",
  tableFamily: "inet",
  tableName: "filter",
  nftablesConfPath: "/etc/nftables.conf",
  dockerInterfaces: ["docker0"],
};

Deno.test("requiredRules: forward chain needs established/related plus per-interface iifname/oifname", () => {
  const rules = requiredRules("forward", ["docker0", "br-lan"]);
  assertEquals(rules, [
    "ct state established,related accept",
    'iifname "docker0" accept',
    'oifname "docker0" accept',
    'iifname "br-lan" accept',
    'oifname "br-lan" accept',
  ]);
});

Deno.test("requiredRules: input chain only needs iifname per interface, no oifname or established/related", () => {
  const rules = requiredRules("input", ["docker0"]);
  assertEquals(rules, ['iifname "docker0" accept']);
});

// deno-lint-ignore no-explicit-any
function sshMock(handleCommand: (command: string) => any) {
  return (cmd: string, args: string[]) => {
    if (cmd === "ssh") {
      if (args.includes("-O")) return { stdout: "", code: 1 };
      if (args.includes("-M")) return { stdout: "", code: 0 };
      return handleCommand(args[args.length - 1]);
    }
    return { stdout: "", stderr: `unexpected command: ${cmd}`, code: 1 };
  };
}

Deno.test("check reports compliant when both chains already contain the required rules", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  await withMockedCommand(
    sshMock((command) => {
      if (command.includes(" forward ")) {
        return {
          stdout:
            'ct state established,related accept\niifname "docker0" accept\noifname "docker0" accept',
          code: 0,
        };
      }
      if (command.includes(" input ")) {
        return { stdout: 'iifname "docker0" accept', code: 0 };
      }
      return { stdout: "", stderr: "unexpected", code: 1 };
    }),
    // deno-lint-ignore no-explicit-any
    () => model.methods.check.execute({}, context as any),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.status, "compliant");
  assertEquals(written[0].data.changes, []);
});

Deno.test("check reports non_compliant and lists exactly the missing rules per chain", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  await withMockedCommand(
    sshMock((command) => {
      if (command.includes(" forward ")) return { stdout: "", code: 0 };
      if (command.includes(" input ")) return { stdout: "", code: 0 };
      return { stdout: "", stderr: "unexpected", code: 1 };
    }),
    // deno-lint-ignore no-explicit-any
    () => model.methods.check.execute({}, context as any),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.status, "non_compliant");
  assertEquals((written[0].data.changes as string[]).length, 4);
});

Deno.test("apply inserts missing rules live via `nft insert rule`, never a full reload", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  let inserted = false;
  const { calls } = await withMockedCommand(
    sshMock((command) => {
      if (command.includes("nft list chain")) {
        if (!inserted) return { stdout: "", code: 0 };
        return command.includes(" forward ")
          ? {
            stdout:
              'ct state established,related accept\niifname "docker0" accept\noifname "docker0" accept',
            code: 0,
          }
          : { stdout: 'iifname "docker0" accept', code: 0 };
      }
      if (command.startsWith("nft insert rule")) {
        inserted = true;
        return { stdout: "", code: 0 };
      }
      if (command.includes("sed -i")) return { stdout: "", code: 0 };
      return { stdout: "", stderr: `unexpected: ${command}`, code: 1 };
    }),
    // deno-lint-ignore no-explicit-any
    () => model.methods.apply.execute({}, context as any),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.status, "applied");
  assertEquals(written[0].data.error, null);

  const remoteCommands = calls
    .filter((c) => c.command === "ssh")
    .map((c) => c.args[c.args.length - 1]);
  assertEquals(remoteCommands.some((c) => c.startsWith("nft -f")), false);
});

Deno.test("apply records a failed status and throws when a live nft insert fails", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  let err: Error | null = null;
  await withMockedCommand(
    sshMock((command) => {
      if (command.includes("nft list chain")) return { stdout: "", code: 0 };
      if (command.startsWith("nft insert rule")) {
        return { stdout: "", stderr: "Operation not permitted", code: 1 };
      }
      return { stdout: "", stderr: `unexpected: ${command}`, code: 1 };
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
  assertEquals(err!.message.includes("Operation not permitted"), true);
  const written = getWrittenResources();
  assertEquals(written[0].data.status, "failed");
});
