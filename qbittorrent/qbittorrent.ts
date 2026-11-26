/**
 * qBittorrent manager — category CRUD, connection verification, adding
 * torrents (magnet or .torrent URL), and torrent visibility via the WebUI
 * API (v2). Unlike most \*arr-family
 * services, qBittorrent authenticates with a username/password login that
 * issues a short-lived session cookie (`SID`), not a static API key — every
 * method here logs in fresh and discards the session afterward rather than
 * trying to persist one across separate method invocations. Both
 * credentials should always be supplied as vault CEL expressions
 * (`${{ vault.get(vault-name, key) }}`) at model-instance creation time,
 * never as literal values, so the raw values are resolved by swamp's
 * runtime and never have to pass through an agent's hands.
 *
 * @module
 */
// extensions/models/qbittorrent-ext/qbittorrent.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  baseUrl: z.string().describe(
    "qBittorrent WebUI base URL, e.g. http://gluetun:8080 " +
      "(qBittorrent commonly shares its VPN container's network namespace, " +
      "so its own hostname is often unreachable — check network_mode first)",
  ),
  username: z.string().meta({ sensitive: true }).describe(
    "qBittorrent WebUI username. Supply via a vault expression " +
      "(${{ vault.get(vault-name, key) }}) — never a literal value.",
  ),
  password: z.string().meta({ sensitive: true }).describe(
    "qBittorrent WebUI password. Supply via a vault expression " +
      "(${{ vault.get(vault-name, key) }}) — never a literal value. " +
      "Note: qBittorrent bans an IP for 1 hour after 5 failed login " +
      "attempts within a short window — avoid rapid repeated calls with " +
      "unverified credentials.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CategorySchema = z.object({
  name: z.string(),
  savePath: z.string(),
}).passthrough();
type CategoryData = z.infer<typeof CategorySchema>;

const TorrentSchema = z.object({
  hash: z.string(),
  name: z.string(),
  category: z.string(),
  state: z.string(),
  progress: z.number().describe("Fraction complete, 0.0 to 1.0"),
  sizeBytes: z.number(),
  downloadedBytes: z.number(),
  numSeeds: z.number().describe("Connected seeds for this torrent right now"),
  numLeechs: z.number().describe(
    "Connected leechers for this torrent right now",
  ),
  dlspeedBytesPerSec: z.number(),
  savePath: z.string(),
  addedOn: z.iso.datetime().nullable(),
  fetchedAt: z.iso.datetime(),
}).passthrough();
type TorrentData = z.infer<typeof TorrentSchema>;

/** Thrown for a non-2xx response, a failed login, or an unparseable body. */
class QbittorrentApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "QbittorrentApiError";
  }
}

/**
 * Log in and return the `SID` session cookie. qBittorrent signals failure
 * via response body text ("Fails.") with an HTTP 200, not a non-2xx status
 * — the body must be checked, not just `response.ok`.
 */
async function login(globalArgs: GlobalArgs): Promise<string> {
  const response = await fetch(`${globalArgs.baseUrl}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: globalArgs.username,
      password: globalArgs.password,
    }),
  });

  if (!response.ok) {
    throw new QbittorrentApiError(
      response.status,
      `qBittorrent login failed with HTTP ${response.status}`,
    );
  }

  const text = await response.text();
  if (text.trim() !== "Ok.") {
    throw new QbittorrentApiError(
      response.status,
      `qBittorrent login rejected: ${text.trim()}`,
    );
  }

  const setCookie = response.headers.get("set-cookie");
  const match = setCookie?.match(/SID=([^;]+)/);
  if (!match) {
    throw new QbittorrentApiError(
      response.status,
      "qBittorrent login succeeded but no SID cookie was returned",
    );
  }
  return match[1];
}

/** Log in, then call a qBittorrent WebUI API endpoint with the session cookie. */
async function qbittorrentFetch(
  globalArgs: GlobalArgs,
  method: string,
  path: string,
  body?: URLSearchParams | FormData,
): Promise<unknown> {
  const sid = await login(globalArgs);

  // FormData sets its own multipart Content-Type (with boundary) via fetch —
  // setting one manually here would drop the boundary and break the upload.
  const isFormData = typeof FormData !== "undefined" &&
    body instanceof FormData;

  const response = await fetch(`${globalArgs.baseUrl}${path}`, {
    method,
    headers: {
      Cookie: `SID=${sid}`,
      ...(body && !isFormData
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new QbittorrentApiError(
      response.status,
      `qBittorrent API error ${response.status} [${method} ${path}]: ${
        text.slice(0, 500)
      }`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  return await response.text();
}

type LoggerContext = {
  logger: { info(msg: string, ...args: unknown[]): void };
};

/** qBittorrent manager: category CRUD, connection verification, torrent visibility. */
export const model = {
  type: "@kitquiet/qbittorrent",
  version: "2026.07.29.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "category": {
      description: "A configured qBittorrent category",
      schema: CategorySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "connection_status": {
      description: "Result of a qBittorrent login/connectivity check",
      schema: z.object({
        connected: z.boolean(),
        checkedAt: z.string(),
      }),
      lifetime: "1h",
      garbageCollection: 5,
    },
    "torrent": {
      description: "A torrent's current state (one record per torrent hash)",
      schema: TorrentSchema,
      lifetime: "1h",
      garbageCollection: 200,
    },
  },
  checks: {
    "qbittorrent-reachable": {
      description:
        "Confirm qBittorrent is reachable at baseUrl and the credentials authenticate",
      labels: ["live"],
      appliesTo: [
        "add_category",
        "remove_category",
        "add_torrent",
        "remove_torrent",
      ],
      execute: async (
        context: { globalArgs: GlobalArgs },
      ) => {
        try {
          await login(context.globalArgs);
          return { pass: true };
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          return {
            pass: false,
            errors: [
              `Could not authenticate to qBittorrent at ${context.globalArgs.baseUrl}: ${message}`,
            ],
          };
        }
      },
    },
  },
  methods: {
    test_connection: {
      description:
        "Verify the configured credentials authenticate successfully, without making any other change",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        let connected = false;
        try {
          await login(context.globalArgs);
          connected = true;
          context.logger.info("qBittorrent login succeeded", {});
        } catch (error) {
          context.logger.info("qBittorrent login failed: {error}", {
            error: error instanceof Error ? error.message : String(error),
          });
        }

        const handle = await context.writeResource(
          "connection_status",
          "current",
          {
            connected,
            checkedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    list_categories: {
      description: "List all configured qBittorrent categories",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        context.logger.info("Fetching categories from {baseUrl}", {
          baseUrl: context.globalArgs.baseUrl,
        });
        const raw = await qbittorrentFetch(
          context.globalArgs,
          "GET",
          "/api/v2/torrents/categories",
        ) as Record<string, { name: string; savePath: string }>;

        const handles = [];
        for (const [name, data] of Object.entries(raw)) {
          const handle = await context.writeResource("category", name, data);
          handles.push(handle);
        }
        context.logger.info("Stored {count} categories", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
    add_category: {
      description:
        "Create a qBittorrent category (idempotent: no-op if it already exists)",
      arguments: z.object({
        name: z.string().describe("Category name"),
        savePath: z.string().default("").describe(
          "Optional save path override for this category",
        ),
      }),
      execute: async (
        args: { name: string; savePath: string },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const existing = await qbittorrentFetch(
          context.globalArgs,
          "GET",
          "/api/v2/torrents/categories",
        ) as Record<string, unknown>;

        if (args.name in existing) {
          context.logger.info(
            "Category {name} already exists, skipping create",
            { name: args.name },
          );
        } else {
          context.logger.info("Creating category {name}", { name: args.name });
          await qbittorrentFetch(
            context.globalArgs,
            "POST",
            "/api/v2/torrents/createCategory",
            new URLSearchParams({
              category: args.name,
              savePath: args.savePath,
            }),
          );
        }

        const handle = await context.writeResource("category", args.name, {
          name: args.name,
          savePath: args.savePath,
        });
        return { dataHandles: [handle] };
      },
    },
    remove_category: {
      description: "Remove a qBittorrent category",
      arguments: z.object({
        name: z.string().describe("Category name to remove"),
      }),
      execute: async (
        args: { name: string },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          deleteResource: (instanceName: string) => Promise<void>;
        },
      ) => {
        await qbittorrentFetch(
          context.globalArgs,
          "POST",
          "/api/v2/torrents/removeCategories",
          new URLSearchParams({ categories: args.name }),
        );
        await context.deleteResource!(args.name);
        context.logger.info("Removed category {name}", { name: args.name });
        return { dataHandles: [] };
      },
    },
    add_torrent: {
      description:
        "Add a torrent by magnet link or a URL that serves a .torrent file " +
        "(qBittorrent fetches it itself). Not idempotent in the strict " +
        "sense — adding an already-present torrent is a no-op on " +
        "qBittorrent's side, but this method does not pre-check for that.",
      arguments: z.object({
        url: z.string().describe(
          "Magnet URI or an http(s) URL that serves a .torrent file",
        ),
        category: z.string().default("").describe(
          "Optional category to assign (must already exist — see add_category)",
        ),
        paused: z.boolean().default(false).describe(
          "Add in a paused state instead of starting immediately",
        ),
      }),
      execute: async (
        args: { url: string; category: string; paused: boolean },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
        },
      ) => {
        context.logger.info("Adding torrent from {url}", { url: args.url });
        const form = new FormData();
        form.append("urls", args.url);
        if (args.category) form.append("category", args.category);
        form.append("paused", args.paused ? "true" : "false");

        const result = await qbittorrentFetch(
          context.globalArgs,
          "POST",
          "/api/v2/torrents/add",
          form,
        ) as string;

        // qBittorrent signals a rejected add (bad URL, duplicate outright
        // refused, etc.) via HTTP 200 with a non-"Ok." body, same pattern as
        // login — must check the body, not just the status.
        if (result.trim() !== "Ok.") {
          throw new QbittorrentApiError(
            200,
            `qBittorrent rejected the torrent add: ${result.trim()}`,
          );
        }
        context.logger.info("Torrent add accepted by qBittorrent", {});
        return { dataHandles: [] };
      },
    },
    list_torrents: {
      description:
        "List current torrents and store each as a resource (optionally " +
        "filtered by category)",
      arguments: z.object({
        category: z.string().optional().describe(
          "Only list torrents in this category",
        ),
      }),
      execute: async (
        args: { category?: string },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const path = args.category
          ? `/api/v2/torrents/info?category=${
            encodeURIComponent(args.category)
          }`
          : "/api/v2/torrents/info";
        context.logger.info("Fetching torrents from {baseUrl}", {
          baseUrl: context.globalArgs.baseUrl,
        });
        const fetchedAt = new Date().toISOString();
        const raw = await qbittorrentFetch(
          context.globalArgs,
          "GET",
          path,
        ) as Array<Record<string, unknown>>;

        const handles = [];
        for (const t of raw) {
          const hash = String(t.hash ?? "");
          const record: TorrentData = {
            hash,
            name: String(t.name ?? ""),
            category: String(t.category ?? ""),
            state: String(t.state ?? "unknown"),
            progress: Number(t.progress ?? 0),
            sizeBytes: Number(t.size ?? 0),
            downloadedBytes: Number(t.downloaded ?? 0),
            numSeeds: Number(t.num_seeds ?? 0),
            numLeechs: Number(t.num_leechs ?? 0),
            dlspeedBytesPerSec: Number(t.dlspeed ?? 0),
            savePath: String(t.save_path ?? ""),
            addedOn: typeof t.added_on === "number" && t.added_on > 0
              ? new Date(t.added_on * 1000).toISOString()
              : null,
            fetchedAt,
          };
          handles.push(await context.writeResource("torrent", hash, record));
        }
        context.logger.info("Stored {count} torrent(s)", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
    remove_torrent: {
      description:
        "Remove a torrent by hash (succeeds if already gone). Does not " +
        "delete downloaded files unless deleteFiles is set.",
      arguments: z.object({
        hash: z.string().describe("The torrent's info hash"),
        deleteFiles: z.boolean().default(false).describe(
          "Also delete the downloaded files from disk",
        ),
      }),
      execute: async (
        args: { hash: string; deleteFiles: boolean },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          deleteResource: (instanceName: string) => Promise<void>;
        },
      ) => {
        context.logger.info("Removing torrent {hash}", { hash: args.hash });
        await qbittorrentFetch(
          context.globalArgs,
          "POST",
          "/api/v2/torrents/delete",
          new URLSearchParams({
            hashes: args.hash,
            deleteFiles: args.deleteFiles ? "true" : "false",
          }),
        );
        await context.deleteResource!(args.hash);
        context.logger.info("Removed torrent {hash}", { hash: args.hash });
        return { dataHandles: [] };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.07.29.1",
      description: "No attribute shape change to existing resources — adds " +
        "add_torrent, list_torrents, and remove_torrent methods plus the " +
        "new torrent resource",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
};
