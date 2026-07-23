/**
 * Shelfarr manager — download client, acquisition provider, and settings
 * configuration for Shelfarr, an audiobook/ebook acquisition tool. Shelfarr
 * itself has no admin API for this surface (only session-cookie/CSRF-
 * protected HTML forms), so this extension talks to a small companion
 * shim (github.com/KitQuietDev/swamp-contributions, shelfarr-admin-shim)
 * that exposes a narrow, token-authenticated JSON API in front of it. The
 * shim is deliberately not generic — it maps each endpoint to one fixed
 * Rails operation, with caller-supplied values always passed as data, never
 * interpolated into code, so it cannot be used to run arbitrary commands
 * inside the Shelfarr container.
 *
 * This means baseUrl here points at the shim, not at Shelfarr directly.
 * The API key is a globalArguments field, meant to be supplied as a vault
 * CEL expression (${{ vault.get(vault-name, key) }}) rather than a literal
 * string, resolved by swamp's runtime at execution time.
 *
 * @module
 */
// extensions/models/shelfarr-ext/shelfarr.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  baseUrl: z.string().describe(
    "Base URL of the shelfarr-admin-shim companion service (not Shelfarr " +
      "itself), e.g. http://localhost:8090",
  ),
  apiKey: z.string().meta({ sensitive: true }).describe(
    "The shim's own API key (its SHIM_API_KEY, not any Shelfarr/Prowlarr/ " +
      "download-client key). Supply via a vault expression " +
      "(${{ vault.get(vault-name, key) }}) — never a literal value.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const DownloadClientResultSchema = z.object({
  ok: z.boolean(),
  id: z.number(),
  name: z.string(),
  persisted: z.boolean(),
});

const AcquisitionProviderResultSchema = z.object({
  ok: z.boolean(),
  id: z.number(),
  name: z.string(),
  persisted: z.boolean(),
});

const SettingsResultSchema = z.object({
  ok: z.boolean(),
  updated: z.record(z.string(), z.string()),
});

const HealthCheckResultSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
});

/** Thrown for a non-2xx response from the shim. */
class ShimApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ShimApiError";
  }
}

/** Call the shelfarr-admin-shim API, throwing {@link ShimApiError} on any non-2xx response. */
async function shimFetch(
  globalArgs: GlobalArgs,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${globalArgs.baseUrl}${path}`, {
    method,
    headers: {
      "X-Api-Key": globalArgs.apiKey,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ShimApiError(
      response.status,
      `Shim API error ${response.status} [${method} ${path}]: ${
        text.slice(0, 500)
      }`,
    );
  }
  return await response.json();
}

type LoggerContext = {
  logger: { info(msg: string, ...args: unknown[]): void };
};

/** Shelfarr manager: download client, acquisition provider, and settings config via the admin shim. */
export const model = {
  type: "@kitquiet/shelfarr",
  version: "2026.07.23.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    "download_client": {
      description: "A configured Shelfarr download client",
      schema: DownloadClientResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "acquisition_provider": {
      description:
        "A configured Shelfarr acquisition provider (indexer source)",
      schema: AcquisitionProviderResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "settings_update": {
      description: "Result of a Shelfarr settings update",
      schema: SettingsResultSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    "health_check": {
      description: "Result of a shelfarr-admin-shim health check",
      schema: HealthCheckResultSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
  },
  checks: {
    "shim-reachable": {
      description:
        "Confirm the shelfarr-admin-shim is reachable and the API key authenticates",
      labels: ["live"],
      appliesTo: [
        "upsert_download_client",
        "upsert_acquisition_provider",
        "update_settings",
      ],
      execute: async (
        context: { globalArgs: GlobalArgs },
      ) => {
        try {
          await shimFetch(context.globalArgs, "GET", "/health");
          return { pass: true };
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          return {
            pass: false,
            errors: [
              `Could not reach the shelfarr-admin-shim at ${context.globalArgs.baseUrl}: ${message}`,
            ],
          };
        }
      },
    },
  },
  methods: {
    upsert_download_client: {
      description:
        "Create or update a Shelfarr download client (idempotent — matches by name)",
      arguments: z.object({
        name: z.string().describe("Display name for the download client"),
        client_type: z.enum([
          "qbittorrent",
          "decypharr",
          "sabnzbd",
          "nzbget",
          "deluge",
          "transmission",
        ]),
        url: z.string().describe("Base URL of the download client"),
        api_key: z.string().meta({ sensitive: true }).optional(),
        username: z.string().optional(),
        password: z.string().meta({ sensitive: true }).optional(),
        download_path: z.string().optional(),
        category: z.string().optional(),
        priority: z.number().default(0),
        enabled: z.boolean().default(true),
      }),
      execute: async (
        args: Record<string, unknown>,
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        context.logger.info("Upserting download client {name}", {
          name: args.name,
        });
        const raw = await shimFetch(
          context.globalArgs,
          "POST",
          "/download-clients",
          args,
        );
        const parsed = DownloadClientResultSchema.parse(raw);

        const handle = await context.writeResource(
          "download_client",
          parsed.name,
          parsed,
        );
        context.logger.info("Download client {name} persisted (id {id})", {
          name: parsed.name,
          id: parsed.id,
        });
        return { dataHandles: [handle] };
      },
    },
    upsert_acquisition_provider: {
      description:
        "Create or update a Shelfarr acquisition provider (idempotent — matches by name)",
      arguments: z.object({
        name: z.string().describe("Display name for the acquisition provider"),
        url: z.string().describe("Base URL of the provider (e.g. Prowlarr)"),
        api_key: z.string().meta({ sensitive: true }).optional(),
        allow_private_network: z.boolean().default(false),
        supports_audiobooks: z.boolean().default(true),
        supports_ebooks: z.boolean().default(true),
        supports_comicbooks: z.boolean().default(false),
        priority: z.number().default(0),
        enabled: z.boolean().default(true),
      }),
      execute: async (
        args: Record<string, unknown>,
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        context.logger.info("Upserting acquisition provider {name}", {
          name: args.name,
        });
        const raw = await shimFetch(
          context.globalArgs,
          "POST",
          "/acquisition-providers",
          args,
        );
        const parsed = AcquisitionProviderResultSchema.parse(raw);

        const handle = await context.writeResource(
          "acquisition_provider",
          parsed.name,
          parsed,
        );
        context.logger.info(
          "Acquisition provider {name} persisted (id {id})",
          { name: parsed.name, id: parsed.id },
        );
        return { dataHandles: [handle] };
      },
    },
    update_settings: {
      description: "Update one or more Shelfarr settings by key",
      arguments: z.object({
        settings: z.record(z.string(), z.string()).describe(
          "A map of setting key to string value, e.g. " +
            '{ "download_remote_path": "/downloads" }',
        ),
      }),
      execute: async (
        args: { settings: Record<string, string> },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        context.logger.info("Updating {count} Shelfarr settings", {
          count: Object.keys(args.settings).length,
        });
        const raw = await shimFetch(
          context.globalArgs,
          "PATCH",
          "/settings",
          args.settings,
        );
        const parsed = SettingsResultSchema.parse(raw);

        const handle = await context.writeResource(
          "settings_update",
          `update-${Date.now()}`,
          parsed,
        );
        return { dataHandles: [handle] };
      },
    },
    health_check: {
      description:
        "Verify the shelfarr-admin-shim is reachable and the API key authenticates, without changing anything",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, unknown>,
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const raw = await shimFetch(context.globalArgs, "GET", "/health");
        const parsed = HealthCheckResultSchema.parse({
          ok: true,
          ...(raw as Record<string, unknown>),
        });

        const handle = await context.writeResource(
          "health_check",
          `health-${Date.now()}`,
          parsed,
        );
        context.logger.info("Shelfarr shim health check: {status}", {
          status: parsed.status,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
