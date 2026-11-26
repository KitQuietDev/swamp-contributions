/**
 * Shared SSH connection pooling + exec/copy helpers for the
 * homelab-ingress model types. There is no supported way for a swamp
 * extension's execute function to call into another model's methods
 * (the MethodContext API has no such mechanism — confirmed against
 * references/model/api.md and by inspecting @swamp/ssh's own source), so
 * each model type here carries its own SSH connection fields and shells
 * out directly, adapting the pattern @adam/cfgmgmt uses for the same
 * reason.
 *
 * @module
 */

const SOCKET_DIR = "/tmp/homelab-ingress-ssh";

export interface SshConn {
  host: string;
  port: number;
  username: string;
  identityFile?: string;
  /** True when `identityFile` was materialized from `identityContent` (a temp file this lib owns and must clean up) rather than a user-supplied path. */
  isTempIdentity: boolean;
  socketPath: string;
  strictHostKeyChecking: string;
}

const POOL_KEY = "__homelab_ingress_ssh_pool";
(globalThis as Record<string, unknown>)[POOL_KEY] =
  (globalThis as Record<string, unknown>)[POOL_KEY] ||
  new Map<string, SshConn>();

const INFLIGHT_KEY = "__homelab_ingress_ssh_inflight";
(globalThis as Record<string, unknown>)[INFLIGHT_KEY] =
  (globalThis as Record<string, unknown>)[INFLIGHT_KEY] ||
  new Map<string, Promise<SshConn>>();

function pool(): Map<string, SshConn> {
  return (globalThis as Record<string, unknown>)[POOL_KEY] as Map<
    string,
    SshConn
  >;
}

function inflight(): Map<string, Promise<SshConn>> {
  return (globalThis as Record<string, unknown>)[INFLIGHT_KEY] as Map<
    string,
    Promise<SshConn>
  >;
}

export interface ConnectOpts {
  host: string;
  port?: number;
  username: string;
  privateKeyPath?: string;
  /** PEM private key content — written to a mode-0600 temp file for the session, removed after. */
  identityContent?: string;
  strictHostKeyChecking?: string;
}

async function checkMaster(
  socketPath: string,
  target: string,
): Promise<boolean> {
  try {
    const cmd = new Deno.Command("ssh", {
      args: ["-o", `ControlPath=${socketPath}`, "-O", "check", target],
      stdout: "null",
      stderr: "null",
    });
    return (await cmd.output()).code === 0;
  } catch {
    return false;
  }
}

/** Materializes identityContent to a private mode-0600 temp file, if supplied, and returns the path to use. */
async function resolveIdentityFile(
  opts: ConnectOpts,
): Promise<string | undefined> {
  if (opts.privateKeyPath) return opts.privateKeyPath;
  if (!opts.identityContent) return undefined;
  const path = await Deno.makeTempFile({ prefix: "homelab-ingress-key-" });
  await Deno.writeTextFile(path, opts.identityContent);
  await Deno.chmod(path, 0o600);
  return path;
}

export function getConnection(opts: ConnectOpts): Promise<SshConn> {
  const port = opts.port ?? 22;
  const key = `${opts.host}:${port}:${opts.username}`;

  const pending = inflight().get(key);
  if (pending) return pending;

  const promise = establishConnection(opts, key, port);
  inflight().set(key, promise);
  promise.finally(() => inflight().delete(key));
  return promise;
}

async function establishConnection(
  opts: ConnectOpts,
  key: string,
  port: number,
): Promise<SshConn> {
  const target = `${opts.username}@${opts.host}`;
  const hostKeyCheck = opts.strictHostKeyChecking ?? "accept-new";
  const existing = pool().get(key);
  if (existing && await checkMaster(existing.socketPath, target)) {
    return existing;
  }
  pool().delete(key);

  try {
    await Deno.mkdir(SOCKET_DIR, { recursive: true, mode: 0o700 });
    await Deno.chmod(SOCKET_DIR, 0o700).catch(() => {});
  } catch {
    // already exists
  }

  const identityFile = await resolveIdentityFile(opts);
  const socketPath = `${SOCKET_DIR}/${opts.host}-${port}-${opts.username}`;
  const conn: SshConn = {
    host: opts.host,
    port,
    username: opts.username,
    identityFile,
    isTempIdentity: Boolean(!opts.privateKeyPath && opts.identityContent),
    socketPath,
    strictHostKeyChecking: hostKeyCheck,
  };

  if (await checkMaster(socketPath, target)) {
    pool().set(key, conn);
    return conn;
  }

  const sshArgs: string[] = [
    "-M",
    "-N",
    "-f",
    "-o",
    `ControlPath=${socketPath}`,
    "-o",
    "ControlPersist=600",
    "-p",
    String(port),
    "-o",
    `StrictHostKeyChecking=${hostKeyCheck}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
  ];
  if (identityFile) sshArgs.push("-i", identityFile);
  sshArgs.push(target);

  const maxRetries = 3;
  const baseDelay = 2000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await Deno.remove(socketPath);
    } catch { /* ok if missing */ }
    const cmd = new Deno.Command("ssh", {
      args: sshArgs,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (output.code === 0) break;
    if (await checkMaster(socketPath, target)) break;
    const stderr = new TextDecoder().decode(output.stderr);
    if (attempt === maxRetries) {
      throw new Error(
        `SSH ControlMaster failed for ${key} after ${
          maxRetries + 1
        } attempts: ${stderr}`,
      );
    }
    await new Promise((r) =>
      setTimeout(r, baseDelay + Math.floor(Math.random() * 1000))
    );
  }

  pool().set(key, conn);
  return conn;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function exec(
  conn: SshConn,
  command: string,
  opts?: { stdinData?: string },
): Promise<ExecResult> {
  const args = [
    "-o",
    `ControlPath=${conn.socketPath}`,
    "-p",
    String(conn.port),
    "-o",
    `StrictHostKeyChecking=${conn.strictHostKeyChecking}`,
    "-o",
    "BatchMode=yes",
  ];
  if (conn.identityFile) args.push("-i", conn.identityFile);
  args.push(`${conn.username}@${conn.host}`, command);

  if (opts?.stdinData) {
    const proc = new Deno.Command("ssh", {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdinData));
    await writer.close();
    const output = await proc.output();
    return {
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
      exitCode: output.code,
    };
  }

  const cmd = new Deno.Command("ssh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    exitCode: output.code,
  };
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export interface BecomeOpts {
  become?: boolean;
  becomeUser?: string;
  becomePassword?: string;
}

export function execSudo(
  conn: SshConn,
  command: string,
  opts?: BecomeOpts,
): Promise<ExecResult> {
  if (!opts?.become) return exec(conn, command);
  const user = opts.becomeUser || "root";
  const escaped = shellEscape(command);
  if (opts.becomePassword) {
    return exec(
      conn,
      `sudo -S -p '' -u ${shellEscape(user)} -- sh -c ${escaped}`,
      { stdinData: opts.becomePassword + "\n" },
    );
  }
  return exec(
    conn,
    `sudo -n -u ${shellEscape(user)} -- sh -c ${escaped}`,
  );
}

/** Writes content to a remote path via a temp file + scp, then sudo mv into place if `opts.become`. */
export async function writeFileAs(
  conn: SshConn,
  remotePath: string,
  content: string,
  opts?: BecomeOpts,
): Promise<void> {
  const tmpFile = await Deno.makeTempFile();
  try {
    await Deno.writeTextFile(tmpFile, content);
    const args = [
      "-o",
      `ControlPath=${conn.socketPath}`,
      "-P",
      String(conn.port),
      "-o",
      `StrictHostKeyChecking=${conn.strictHostKeyChecking}`,
      "-o",
      "BatchMode=yes",
    ];
    if (conn.identityFile) args.push("-i", conn.identityFile);
    const tmpRemote = opts?.become
      ? `/tmp/.homelab-ingress-upload-${crypto.randomUUID()}`
      : remotePath;
    args.push(tmpFile, `${conn.username}@${conn.host}:${tmpRemote}`);

    const cmd = new Deno.Command("scp", {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await cmd.output();
    if (output.code !== 0) {
      const stderr = new TextDecoder().decode(output.stderr);
      throw new Error(`scp to ${tmpRemote} failed: ${stderr}`);
    }

    if (opts?.become) {
      const result = await execSudo(
        conn,
        `mv ${shellEscape(tmpRemote)} ${shellEscape(remotePath)}`,
        opts,
      );
      if (result.exitCode !== 0) {
        await exec(conn, `rm -f ${shellEscape(tmpRemote)}`);
        throw new Error(
          `writeFileAs mv to ${remotePath} failed: ${result.stderr}`,
        );
      }
    }
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
}

export function closeAll(): void {
  for (const conn of pool().values()) {
    try {
      new Deno.Command("ssh", {
        args: [
          "-o",
          `ControlPath=${conn.socketPath}`,
          "-O",
          "exit",
          `${conn.username}@${conn.host}`,
        ],
        stdout: "null",
        stderr: "null",
      }).outputSync();
    } catch {
      // ignore close errors
    }
    // Only remove identity files this lib created from identityContent —
    // never a user-supplied privateKeyPath.
    if (conn.isTempIdentity && conn.identityFile) {
      try {
        Deno.removeSync(conn.identityFile);
      } catch {
        // already gone
      }
    }
  }
  pool().clear();
}
