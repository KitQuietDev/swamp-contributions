/**
 * Unit tests for the fail2ban-jail extension model. Mocks `Deno.Command` via
 * `withMockedCommand` so no real host or `fail2ban-client` binary is
 * required. Specifically covers the discovered gotcha this model exists to
 * encode: `apply` must explicitly restart fail2ban, not just `enable --now`.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  createModelTestContext,
  withMockedCommand,
} from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { desiredFilter, desiredJail, model } from "./fail2ban_jail.ts";

const GLOBAL_ARGS = {
  nodeHost: "vps.test",
  nodeUser: "root",
  nodePort: 22,
  become: false,
  becomeUser: "root",
  jailName: "traefik-badbots",
  filterRegex: '^.*"ClientHost":"<HOST>".*"RequestPath":"(/\\.env.*)".*$',
  logPath: "/opt/traefik-stack/logs/access.log",
  maxRetry: 3,
  findTime: "10m",
  banTime: "1h",
  port: "http,https",
  protocol: "tcp",
  banAction: "nftables-multiport",
};

Deno.test("desiredFilter: embeds the failregex under [Definition] with an empty ignoreregex", () => {
  const filter = desiredFilter(GLOBAL_ARGS);
  assertEquals(filter.startsWith("[Definition]\n"), true);
  assertEquals(filter.includes(GLOBAL_ARGS.filterRegex), true);
  assertEquals(filter.includes("ignoreregex =\n"), true);
});

Deno.test("desiredJail: uses nftables-multiport by default, its own isolated table", () => {
  const jail = desiredJail(GLOBAL_ARGS);
  assertEquals(jail.includes("banaction = nftables-multiport"), true);
  assertEquals(jail.includes(`filter = ${GLOBAL_ARGS.jailName}`), true);
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

Deno.test("apply always runs an explicit restart when config changes, not just enable --now", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  let restarted = false;
  let jailActive = false;

  const { calls } = await withMockedCommand(
    sshMock((command) => {
      if (command === "which fail2ban-client") return { stdout: "", code: 0 };
      if (command.startsWith("cat ")) return { stdout: "", code: 1 }; // no existing filter/jail files
      if (command.startsWith("grep -rlE")) return { stdout: "", code: 1 }; // jail not defined elsewhere
      if (command.startsWith("fail2ban-client status")) {
        return jailActive
          ? { stdout: "Currently banned:\t0\nTotal banned:\t0\n", code: 0 }
          : { stdout: "", code: 1 };
      }
      if (command === "systemctl enable fail2ban") {
        return { stdout: "", code: 0 };
      }
      if (command === "systemctl restart fail2ban") {
        restarted = true;
        jailActive = true;
        return { stdout: "", code: 0 };
      }
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    // deno-lint-ignore no-explicit-any
    () => model.methods.apply.execute({}, context as any),
  );

  assertEquals(restarted, true);
  const written = getWrittenResources();
  assertEquals(written[0].data.status, "applied");
  assertEquals(written[0].data.active, true);

  const remoteCommands = calls
    .filter((c) => c.command === "ssh")
    .map((c) => c.args[c.args.length - 1]);
  assertEquals(remoteCommands.includes("systemctl restart fail2ban"), true);
});

Deno.test("apply throws descriptively if the jail is still inactive after restart", async () => {
  const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });

  let err: Error | null = null;
  await withMockedCommand(
    sshMock((command) => {
      if (command === "which fail2ban-client") return { stdout: "", code: 0 };
      if (command.startsWith("cat ")) return { stdout: "", code: 1 };
      if (command.startsWith("grep -rlE")) return { stdout: "", code: 1 };
      if (command.startsWith("fail2ban-client status")) {
        return { stdout: "", code: 1 }; // never becomes active
      }
      if (command === "systemctl enable fail2ban") {
        return { stdout: "", code: 0 };
      }
      if (command === "systemctl restart fail2ban") {
        return { stdout: "", code: 0 };
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
  assertEquals(err!.message.includes("still not active"), true);
});

Deno.test("apply refuses to write a duplicate jail definition when the jail is already defined in a bundled file elsewhere", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  let err: Error | null = null;
  const { calls } = await withMockedCommand(
    sshMock((command) => {
      if (command === "which fail2ban-client") return { stdout: "", code: 0 };
      if (command.startsWith("cat ") && command.includes("filter.d")) {
        return { stdout: "", code: 1 };
      }
      if (command.startsWith("cat ") && command.includes("jail.d")) {
        return { stdout: "", code: 1 }; // not at the expected per-jail path
      }
      if (command.startsWith("grep -rlE")) {
        return {
          stdout: "/etc/fail2ban/jail.d/custom.local\n",
          code: 0,
        };
      }
      if (command.startsWith("fail2ban-client status")) {
        return { stdout: "Currently banned:\t3\nTotal banned:\t3\n", code: 0 };
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
  assertEquals(
    err!.message.includes("/etc/fail2ban/jail.d/custom.local"),
    true,
  );
  assertEquals(getWrittenResources()[0].data.status, "failed");

  // The filter write (filter.d isn't bundled, so it's unaffected) is fine —
  // only the jail write must be blocked, so exactly one scp (the filter)
  // should have happened, never a second one for the jail file.
  const writeCommands = calls.filter((c) => c.command === "scp").length;
  assertEquals(writeCommands, 1);
});

Deno.test("check reports the jail is defined elsewhere instead of a misleading 'create jail config'", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  await withMockedCommand(
    sshMock((command) => {
      if (command.startsWith("cat ") && command.includes("filter.d")) {
        return { stdout: desiredFilter(GLOBAL_ARGS), code: 0 };
      }
      if (command.startsWith("cat ") && command.includes("jail.d")) {
        return { stdout: "", code: 1 };
      }
      if (command.startsWith("grep -rlE")) {
        return {
          stdout: "/etc/fail2ban/jail.d/custom.local\n",
          code: 0,
        };
      }
      if (command.startsWith("fail2ban-client status")) {
        return { stdout: "Currently banned:\t3\nTotal banned:\t3\n", code: 0 };
      }
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    // deno-lint-ignore no-explicit-any
    () => model.methods.check.execute({}, context as any),
  );

  const written = getWrittenResources();
  const changes = written[0].data.changes as string[];
  assertEquals(
    changes.some((c) => c.includes("already defined in")),
    true,
  );
  assertEquals(changes.some((c) => c === "create jail config"), false);
});

Deno.test("unban runs fail2ban-client set <jail> unbanip <ip> and reports the resulting status", async () => {
  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: GLOBAL_ARGS,
  });

  const { calls } = await withMockedCommand(
    sshMock((command) => {
      if (command.startsWith("fail2ban-client set")) {
        return { stdout: "1\n", code: 0 };
      }
      if (command.startsWith("fail2ban-client status")) {
        return { stdout: "Currently banned:\t2\nTotal banned:\t9\n", code: 0 };
      }
      return { stdout: "", stderr: `unhandled: ${command}`, code: 1 };
    }),
    () =>
      model.methods.unban.execute(
        { ip: "198.51.100.7" },
        // deno-lint-ignore no-explicit-any
        context as any,
      ),
  );

  const written = getWrittenResources();
  assertEquals(written[0].data.status, "applied");
  assertEquals(written[0].data.currentlyBanned, 2);

  const remoteCommands = calls
    .filter((c) => c.command === "ssh")
    .map((c) => c.args[c.args.length - 1]);
  assertEquals(
    remoteCommands.some((c) =>
      c.includes("unbanip") && c.includes("198.51.100.7")
    ),
    true,
  );
});
