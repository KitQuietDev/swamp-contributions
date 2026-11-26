/**
 * Prowlarr indexer manager — list, add (Torznab), update, sync, and remove
 * indexers via Prowlarr's REST API. Authenticates with an X-Api-Key header;
 * the key should always be supplied as a vault CEL expression
 * (`${{ vault.get(vault-name, key) }}`) at model-instance creation time, never
 * as a literal string, so the raw value is resolved by swamp's runtime and
 * never has to pass through an agent's hands.
 *
 * @module
 */
// extensions/models/prowlarr-ext/prowlarr.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  baseUrl: z.string().describe(
    "Prowlarr base URL, e.g. http://prowlarr:9696",
  ),
  apiKey: z.string().meta({ sensitive: true }).describe(
    "Prowlarr API key. Supply via a vault expression " +
      "(${{ vault.get(vault-name, key) }}) — never a literal value.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const IndexerSchema = z.object({
  id: z.number(),
  name: z.string(),
  enable: z.boolean(),
  protocol: z.string(),
  priority: z.number(),
  implementation: z.string(),
}).passthrough();
type IndexerData = z.infer<typeof IndexerSchema>;

const IndexerListSchema = z.array(IndexerSchema);

/** Thrown by {@link prowlarrFetch} for a non-2xx response; carries the HTTP status. */
class ProwlarrApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ProwlarrApiError";
  }
}

/** Call the Prowlarr REST API, throwing {@link ProwlarrApiError} on any non-2xx response. */
async function prowlarrFetch(
  globalArgs: GlobalArgs,
  method: string,
  path: string,
  body?: unknown,
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
    throw new ProwlarrApiError(
      response.status,
      `Prowlarr API error ${response.status} [${method} ${path}]: ${
        text.slice(0, 500)
      }`,
    );
  }
  if (response.status === 204) return null;
  return await response.json();
}

/** Fetch and validate the full indexer list against {@link IndexerListSchema}. */
async function fetchIndexerList(
  globalArgs: GlobalArgs,
): Promise<IndexerData[]> {
  const raw = await prowlarrFetch(globalArgs, "GET", "/api/v1/indexer");
  const parsed = IndexerListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Prowlarr returned an indexer list that didn't match the expected shape: ${
        parsed.error.message.slice(0, 500)
      }`,
    );
  }
  return parsed.data;
}

/** Fetch and validate a single indexer against {@link IndexerSchema}. */
async function fetchIndexerById(
  globalArgs: GlobalArgs,
  indexerId: number,
): Promise<IndexerData> {
  const raw = await prowlarrFetch(
    globalArgs,
    "GET",
    `/api/v1/indexer/${indexerId}`,
  );
  const parsed = IndexerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Prowlarr returned an indexer that didn't match the expected shape: ${
        parsed.error.message.slice(0, 500)
      }`,
    );
  }
  return parsed.data;
}

type LoggerContext = {
  logger: { info(msg: string, ...args: unknown[]): void };
};

/** Prowlarr indexer manager: list, add (Torznab), update, sync, and remove indexers. */
export const model = {
  type: "@kitquiet/prowlarr",
  version: "2026.07.29.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "indexer": {
      description: "A configured Prowlarr indexer",
      schema: IndexerSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  checks: {
    "prowlarr-reachable": {
      description:
        "Confirm Prowlarr is reachable at baseUrl and the API key authenticates",
      labels: ["live"],
      appliesTo: [
        "add_torznab_indexer",
        "update_indexer",
        "remove_indexer",
      ],
      execute: async (
        context: { globalArgs: GlobalArgs },
      ) => {
        try {
          await prowlarrFetch(context.globalArgs, "GET", "/api/v1/indexer");
          return { pass: true };
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          return {
            pass: false,
            errors: [
              `Could not reach Prowlarr at ${context.globalArgs.baseUrl}: ${message}`,
            ],
          };
        }
      },
    },
  },
  methods: {
    list_indexers: {
      description:
        "List all configured Prowlarr indexers and store each as a resource",
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
        context.logger.info("Fetching indexers from {baseUrl}", {
          baseUrl: context.globalArgs.baseUrl,
        });
        const indexers = await fetchIndexerList(context.globalArgs);

        const handles = [];
        for (const idx of indexers) {
          const handle = await context.writeResource(
            "indexer",
            `indexer-${idx.id}`,
            idx,
          );
          handles.push(handle);
        }
        context.logger.info("Stored {count} indexers", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
    add_torznab_indexer: {
      description:
        "Add a Torznab-compatible indexer (e.g. a Jackett feed) to Prowlarr. " +
        "Idempotent: returns the existing indexer if one with the same name is already configured.",
      arguments: z.object({
        name: z.string().describe(
          "Display name for the indexer in Prowlarr",
        ),
        siteBaseUrl: z.string().describe(
          "Base URL of the Torznab site, e.g. http://jackett:9117",
        ),
        apiPath: z.string().describe(
          "Path to the Torznab endpoint, e.g. " +
            "/api/v2.0/indexers/audiobookbay/results/torznab",
        ),
        siteApiKey: z.string().meta({ sensitive: true }).describe(
          "API key for the Torznab site itself (not Prowlarr's own key)",
        ),
        appProfileId: z.number().default(1).describe(
          "Prowlarr app sync profile ID (1 = Standard, by default)",
        ),
      }),
      execute: async (
        args: {
          name: string;
          siteBaseUrl: string;
          apiPath: string;
          siteApiKey: string;
          appProfileId: number;
        },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        // Idempotent: a retried call must not create a duplicate indexer.
        const existing = await fetchIndexerList(context.globalArgs);
        const alreadyExists = existing.find((idx) => idx.name === args.name);
        if (alreadyExists) {
          context.logger.info(
            "Indexer {name} already exists (id {id}), skipping create",
            { name: args.name, id: alreadyExists.id },
          );
          const handle = await context.writeResource(
            "indexer",
            `indexer-${alreadyExists.id}`,
            alreadyExists,
          );
          return { dataHandles: [handle] };
        }

        context.logger.info("Adding Torznab indexer {name}", {
          name: args.name,
        });
        const schemas = await prowlarrFetch(
          context.globalArgs,
          "GET",
          "/api/v1/indexer/schema",
        ) as Array<Record<string, unknown>>;

        const template = schemas.find((s) => s.name === "Generic Torznab");
        if (!template) {
          throw new Error(
            "Prowlarr did not return a 'Generic Torznab' indexer schema template",
          );
        }

        const body = structuredClone(template);
        body.name = args.name;
        body.appProfileId = args.appProfileId;
        body.fields = (body.fields as Array<Record<string, unknown>>).map(
          (f) => {
            if (f.name === "baseUrl") return { ...f, value: args.siteBaseUrl };
            if (f.name === "apiPath") return { ...f, value: args.apiPath };
            if (f.name === "apiKey") return { ...f, value: args.siteApiKey };
            return f;
          },
        );
        delete body.id;
        delete body.infoLink;

        const rawCreated = await prowlarrFetch(
          context.globalArgs,
          "POST",
          "/api/v1/indexer",
          body,
        );
        const created = IndexerSchema.parse(rawCreated);

        const handle = await context.writeResource(
          "indexer",
          `indexer-${created.id}`,
          created,
        );
        context.logger.info("Created indexer {name} (id {id})", {
          name: created.name,
          id: created.id,
        });
        return { dataHandles: [handle] };
      },
    },
    update_indexer: {
      description:
        "Update an existing Prowlarr indexer's enable, priority, app profile, and/or redirect setting",
      arguments: z.object({
        indexerId: z.number().describe("The Prowlarr indexer ID to update"),
        enable: z.boolean().optional().describe(
          "Enable or disable the indexer",
        ),
        priority: z.number().optional().describe(
          "Search priority (lower runs first)",
        ),
        appProfileId: z.number().optional().describe(
          "Prowlarr app sync profile ID",
        ),
        redirect: z.boolean().optional().describe(
          "When true, Prowlarr returns the indexer's raw download URL as-is " +
            "(client fetches directly). When false, Prowlarr proxies the " +
            "download itself, appending its own stored credentials — " +
            "required for indexers whose raw links omit auth (e.g. an " +
            "apikey query param), which otherwise fail with an indexer-side " +
            '"missing parameter" error. Only meaningful when the indexer\'s ' +
            "supportsRedirect capability is true.",
        ),
      }),
      execute: async (
        args: {
          indexerId: number;
          enable?: boolean;
          priority?: number;
          appProfileId?: number;
          redirect?: boolean;
        },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        // Read-modify-write against Prowlarr's live state, not swamp's local
        // cache — the cache can be stale relative to changes made outside
        // this model (e.g. through Prowlarr's own UI).
        const current = await fetchIndexerById(
          context.globalArgs,
          args.indexerId,
        );

        const updated: Record<string, unknown> = { ...current };
        if (args.enable !== undefined) updated.enable = args.enable;
        if (args.priority !== undefined) updated.priority = args.priority;
        if (args.appProfileId !== undefined) {
          updated.appProfileId = args.appProfileId;
        }
        if (args.redirect !== undefined) updated.redirect = args.redirect;

        context.logger.info("Updating indexer {id}", { id: args.indexerId });
        const rawResult = await prowlarrFetch(
          context.globalArgs,
          "PUT",
          `/api/v1/indexer/${args.indexerId}`,
          updated,
        );
        const result = IndexerSchema.parse(rawResult);

        const handle = await context.writeResource(
          "indexer",
          `indexer-${result.id}`,
          result,
        );
        context.logger.info("Updated indexer {id}", { id: result.id });
        return { dataHandles: [handle] };
      },
    },
    sync_indexer: {
      description:
        "Refresh a single indexer's stored state from live Prowlarr data. " +
        "Writes a not_found marker (rather than throwing) if the indexer no longer exists.",
      arguments: z.object({
        indexerId: z.number().describe(
          "The Prowlarr indexer ID to refresh",
        ),
      }),
      execute: async (
        args: { indexerId: number },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        try {
          const live = await fetchIndexerById(
            context.globalArgs,
            args.indexerId,
          );
          const handle = await context.writeResource(
            "indexer",
            `indexer-${args.indexerId}`,
            live,
          );
          context.logger.info("Synced indexer {id}", { id: args.indexerId });
          return { dataHandles: [handle] };
        } catch (error) {
          if (error instanceof ProwlarrApiError && error.status === 404) {
            context.logger.info(
              "Indexer {id} no longer exists in Prowlarr",
              { id: args.indexerId },
            );
            const handle = await context.writeResource(
              "indexer",
              `indexer-${args.indexerId}`,
              {
                id: args.indexerId,
                name: "",
                enable: false,
                protocol: "unknown",
                priority: 0,
                implementation: "unknown",
                status: "not_found",
                syncedAt: new Date().toISOString(),
              },
            );
            return { dataHandles: [handle] };
          }
          throw error;
        }
      },
    },
    remove_indexer: {
      description:
        "Remove an indexer from Prowlarr by ID (succeeds if already gone)",
      arguments: z.object({
        indexerId: z.number().describe("The Prowlarr indexer ID to remove"),
      }),
      execute: async (
        args: { indexerId: number },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          deleteResource: (instanceName: string) => Promise<void>;
        },
      ) => {
        try {
          await prowlarrFetch(
            context.globalArgs,
            "DELETE",
            `/api/v1/indexer/${args.indexerId}`,
          );
        } catch (error) {
          // Already gone is success for a delete — not a failure to report.
          if (error instanceof ProwlarrApiError && error.status === 404) {
            context.logger.info(
              "Indexer {id} was already removed from Prowlarr",
              { id: args.indexerId },
            );
          } else {
            throw error;
          }
        }
        await context.deleteResource!(`indexer-${args.indexerId}`);
        context.logger.info("Removed indexer {id}", { id: args.indexerId });
        return { dataHandles: [] };
      },
    },
  },
  upgrades: [
    {
      toVersion: "2026.07.23.2",
      description:
        "No attribute shape change — version bump for update_indexer, sync_indexer, and pre-flight checks",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.23.3",
      description:
        "No attribute shape change — version bump for repository consolidation into swamp-contributions",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.23.4",
      description:
        "No attribute shape change — .3 was published without its required upgrade entry; this corrects that",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.07.29.1",
      description:
        "No attribute shape change — update_indexer gains a redirect argument",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
};
