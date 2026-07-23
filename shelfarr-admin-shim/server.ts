/**
 * Shelfarr admin shim — exposes a narrow, token-authenticated JSON API for
 * Shelfarr admin operations (DownloadClient, AcquisitionProvider, Settings)
 * that Shelfarr itself only exposes via session-cookie/CSRF-protected HTML
 * forms, not a real API.
 *
 * Deliberately NOT a generic "run arbitrary Ruby" proxy. Each endpoint maps
 * to one fixed, pre-written Rails runner script. Caller-supplied values
 * always travel as JSON data written to a temp file the script reads and
 * parses — never interpolated into Ruby source as a string — so this
 * cannot be used to execute arbitrary code inside the Shelfarr container,
 * only the specific operations defined here.
 *
 * @module
 */
import { z } from "npm:zod@4";

const PORT = Number(Deno.env.get("SHIM_PORT") ?? "8090");
const API_KEY = Deno.env.get("SHIM_API_KEY");
const SHELFARR_CONTAINER = Deno.env.get("SHELFARR_CONTAINER") ?? "shelfarr";
// Static .rb scripts baked into this container's own image at build time
// (read-only). Not a host path — this container runs the `docker` CLI
// itself, so `docker cp` reads local paths from its own filesystem.
const RAILS_OPS_DIR = Deno.env.get("RAILS_OPS_DIR") ?? "/app/rails_ops";
// Writable scratch space inside this container for per-request JSON
// payloads, cleaned up immediately after each operation.
const TMP_DIR = Deno.env.get("SHIM_TMP_DIR") ?? "/app/tmp";
await Deno.mkdir(TMP_DIR, { recursive: true });

if (!API_KEY) {
  console.error(
    "SHIM_API_KEY must be set — refusing to start unauthenticated.",
  );
  Deno.exit(1);
}

const DownloadClientSchema = z.object({
  name: z.string(),
  client_type: z.enum([
    "qbittorrent",
    "decypharr",
    "sabnzbd",
    "nzbget",
    "deluge",
    "transmission",
  ]),
  url: z.string(),
  api_key: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  download_path: z.string().optional(),
  category: z.string().optional(),
  priority: z.number().default(0),
  enabled: z.boolean().default(true),
});

const AcquisitionProviderSchema = z.object({
  name: z.string(),
  url: z.string(),
  api_key: z.string().optional(),
  allow_private_network: z.boolean().default(false),
  supports_audiobooks: z.boolean().default(true),
  supports_ebooks: z.boolean().default(true),
  supports_comicbooks: z.boolean().default(false),
  priority: z.number().default(0),
  enabled: z.boolean().default(true),
});

const SettingsUpdateSchema = z.record(z.string(), z.string());

/** Run a fixed Rails runner script against a JSON data file inside the Shelfarr container. */
async function runRailsOp(
  scriptName: string,
  data: Record<string, unknown>,
): Promise<{ ok: boolean; output: string }> {
  const dataFileName = `${scriptName}-${crypto.randomUUID()}.json`;
  const localDataPath = `${TMP_DIR}/${dataFileName}`;
  const containerDataPath = `/tmp/${dataFileName}`;

  await Deno.writeTextFile(localDataPath, JSON.stringify(data));

  try {
    const copy = new Deno.Command("docker", {
      args: [
        "cp",
        localDataPath,
        `${SHELFARR_CONTAINER}:${containerDataPath}`,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const copyResult = await copy.output();
    if (!copyResult.success) {
      return {
        ok: false,
        output: new TextDecoder().decode(copyResult.stderr),
      };
    }

    const copyScript = new Deno.Command("docker", {
      args: [
        "cp",
        `${RAILS_OPS_DIR}/${scriptName}.rb`,
        `${SHELFARR_CONTAINER}:/tmp/${scriptName}.rb`,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    await copyScript.output();

    const exec = new Deno.Command("docker", {
      args: [
        "exec",
        SHELFARR_CONTAINER,
        "bash",
        "-c",
        `source /rails/storage/.encryption_keys && ` +
        `export SECRET_KEY_BASE=$(cat /rails/storage/.secret_key_base) && ` +
        `SHIM_DATA_PATH=${containerDataPath} bin/rails runner /tmp/${scriptName}.rb`,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const execResult = await exec.output();
    const stdout = new TextDecoder().decode(execResult.stdout);
    const stderr = new TextDecoder().decode(execResult.stderr);

    return {
      ok: execResult.success,
      output: execResult.success ? stdout : stderr,
    };
  } finally {
    await Deno.remove(localDataPath).catch(() => {});
    await new Deno.Command("docker", {
      args: ["exec", SHELFARR_CONTAINER, "rm", "-f", containerDataPath],
    }).output().catch(() => {});
  }
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function checkAuth(req: Request): boolean {
  const provided = req.headers.get("x-api-key");
  return provided === API_KEY;
}

async function handleDownloadClient(req: Request): Promise<Response> {
  const body = await req.json();
  const parsed = DownloadClientSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: parsed.error.message }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const result = await runRailsOp("upsert_download_client", parsed.data);
  return new Response(result.output, {
    status: result.ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
}

async function handleAcquisitionProvider(req: Request): Promise<Response> {
  const body = await req.json();
  const parsed = AcquisitionProviderSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: parsed.error.message }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const result = await runRailsOp("upsert_acquisition_provider", parsed.data);
  return new Response(result.output, {
    status: result.ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
}

async function handleSettings(req: Request): Promise<Response> {
  const body = await req.json();
  const parsed = SettingsUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: parsed.error.message }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const result = await runRailsOp("update_settings", parsed.data);
  return new Response(result.output, {
    status: result.ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
}

// Binds to all interfaces *inside the container* — this is correct, not a
// loosening. Docker's port mapping (127.0.0.1:8090:8090 in compose)
// delivers forwarded traffic via the container's bridge interface, not
// its own loopback, so binding this process to 127.0.0.1 would refuse
// exactly the traffic Docker forwards to it. The actual host-only
// restriction lives in the compose ports: mapping, not here.
Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  if (!checkAuth(req)) return unauthorized();

  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json" },
    });
  }
  if (req.method === "POST" && url.pathname === "/download-clients") {
    return await handleDownloadClient(req);
  }
  if (req.method === "POST" && url.pathname === "/acquisition-providers") {
    return await handleAcquisitionProvider(req);
  }
  if (req.method === "PATCH" && url.pathname === "/settings") {
    return await handleSettings(req);
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
});

console.log(`Shelfarr admin shim listening on 127.0.0.1:${PORT}`);
