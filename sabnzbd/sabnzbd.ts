/**
 * SABnzbd manager — category CRUD, queue/history visibility, and NZB-by-URL
 * submission via SABnzbd's REST API. Authenticates with an `apikey` query
 * parameter; the key should always be supplied as a vault CEL expression
 * (`${{ vault.get(vault-name, key) }}`) at model-instance creation time,
 * never as a literal string, so the raw value is resolved by swamp's
 * runtime and never has to pass through an agent's hands.
 *
 * @module
 */
// extensions/models/sabnzbd.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  baseUrl: z.string().describe(
    "SABnzbd base URL, e.g. http://sabnzbd:8080 (no url_base prefix — " +
      "SABnzbd's API lives at /api regardless of any reverse-proxy path)",
  ),
  apiKey: z.string().meta({ sensitive: true }).describe(
    "SABnzbd API key. Supply via a vault expression " +
      "(${{ vault.get(vault-name, key) }}) — never a literal value.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CategorySchema = z.object({
  name: z.string(),
  order: z.number(),
  pp: z.string(),
  script: z.string(),
  dir: z.string(),
  priority: z.number(),
}).passthrough();
type CategoryData = z.infer<typeof CategorySchema>;

const QueueSchema = z.object({
  paused: z.boolean(),
  speed: z.string(),
  kbpersec: z.string(),
  mb: z.string(),
  mbleft: z.string(),
  noofslots_total: z.number().optional(),
  slots: z.array(z.record(z.string(), z.unknown())).default([]),
}).passthrough();
type QueueData = z.infer<typeof QueueSchema>;

const HistorySlotSchema = z.object({
  name: z.string(),
  nzo_id: z.string(),
  status: z.string(),
  fail_message: z.string().optional(),
  size: z.string().optional(),
  category: z.string().optional(),
  completed: z.number().optional(),
}).passthrough();
type HistorySlotData = z.infer<typeof HistorySlotSchema>;

/** Thrown by {@link sabnzbdFetch} for a non-2xx response or an API-level error payload. */
class SabnzbdApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "SabnzbdApiError";
  }
}

/**
 * Call SABnzbd's REST API. Note the endpoint is always `/api`, never
 * `/sabnzbd/api` — SABnzbd ignores a `url_base` for its own API path.
 * Throws {@link SabnzbdApiError} on a non-2xx response or on an
 * `{"error": "..."}` payload (SABnzbd returns HTTP 200 for some API-level
 * errors, so the body must be checked, not just the status code).
 */
async function sabnzbdFetch(
  globalArgs: GlobalArgs,
  params: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${globalArgs.baseUrl}/api`);
  url.searchParams.set("apikey", globalArgs.apiKey);
  url.searchParams.set("output", "json");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    const text = await response.text();
    throw new SabnzbdApiError(
      response.status,
      `SABnzbd API error ${response.status} [mode=${params.mode}]: ${
        text.slice(0, 500)
      }`,
    );
  }

  const body = await response.json();
  if (body && typeof body === "object" && "error" in body) {
    throw new SabnzbdApiError(
      response.status,
      `SABnzbd API error [mode=${params.mode}]: ${String(body.error)}`,
    );
  }
  return body;
}

type LoggerContext = {
  logger: { info(msg: string, ...args: unknown[]): void };
};

/** SABnzbd manager: category CRUD, queue/history visibility, NZB-by-URL submission. */
export const model = {
  type: "@kitquiet/sabnzbd",
  version: "2026.07.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "category": {
      description: "A configured SABnzbd category",
      schema: CategorySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "queue": {
      description: "SABnzbd's current download queue snapshot",
      schema: QueueSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    "history_entry": {
      description: "A single SABnzbd history entry (completed or failed)",
      schema: HistorySlotSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
  },
  checks: {
    "sabnzbd-reachable": {
      description:
        "Confirm SABnzbd is reachable at baseUrl and the API key authenticates",
      labels: ["live"],
      appliesTo: ["add_category", "remove_category", "add_nzb_url"],
      execute: async (
        context: { globalArgs: GlobalArgs },
      ) => {
        try {
          await sabnzbdFetch(context.globalArgs, { mode: "get_cats" });
          return { pass: true };
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          return {
            pass: false,
            errors: [
              `Could not reach SABnzbd at ${context.globalArgs.baseUrl}: ${message}`,
            ],
          };
        }
      },
    },
  },
  methods: {
    list_categories: {
      description: "List all configured SABnzbd categories",
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
        const raw = await sabnzbdFetch(context.globalArgs, {
          mode: "get_cats",
        });
        const names = (raw as { categories: string[] }).categories.filter((n) =>
          n !== "*"
        );

        const handles = [];
        for (const name of names) {
          const handle = await context.writeResource("category", name, {
            name,
            order: 0,
            pp: "",
            script: "",
            dir: "",
            priority: 0,
          });
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
        "Create a SABnzbd category (idempotent: no-op if it already exists)",
      arguments: z.object({
        name: z.string().describe("Category name"),
        priority: z.number().default(0).describe(
          "Queue priority for this category",
        ),
      }),
      execute: async (
        args: { name: string; priority: number },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const existing = await sabnzbdFetch(context.globalArgs, {
          mode: "get_cats",
        }) as { categories: string[] };
        if (existing.categories.includes(args.name)) {
          context.logger.info(
            "Category {name} already exists, skipping create",
            {
              name: args.name,
            },
          );
        } else {
          context.logger.info("Creating category {name}", { name: args.name });
          await sabnzbdFetch(context.globalArgs, {
            mode: "set_config",
            section: "categories",
            keyword: args.name,
            name: "priority",
            value: String(args.priority),
          });
        }

        const handle = await context.writeResource("category", args.name, {
          name: args.name,
          order: 0,
          pp: "",
          script: "",
          dir: "",
          priority: args.priority,
        });
        return { dataHandles: [handle] };
      },
    },
    remove_category: {
      description: "Remove a SABnzbd category (succeeds if already gone)",
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
        try {
          await sabnzbdFetch(context.globalArgs, {
            mode: "del_config",
            section: "categories",
            keyword: args.name,
          });
        } catch (error) {
          if (error instanceof SabnzbdApiError) {
            context.logger.info(
              "Category {name} removal reported an error (likely already gone): {error}",
              { name: args.name, error: error.message },
            );
          } else {
            throw error;
          }
        }
        await context.deleteResource!(args.name);
        context.logger.info("Removed category {name}", { name: args.name });
        return { dataHandles: [] };
      },
    },
    get_queue: {
      description: "Snapshot SABnzbd's current download queue",
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
        const raw = await sabnzbdFetch(context.globalArgs, { mode: "queue" });
        const parsed = QueueSchema.safeParse((raw as { queue: unknown }).queue);
        if (!parsed.success) {
          throw new Error(
            `SABnzbd returned a queue that didn't match the expected shape: ${
              parsed.error.message.slice(0, 500)
            }`,
          );
        }
        const handle = await context.writeResource(
          "queue",
          "current",
          parsed.data,
        );
        context.logger.info("Queue snapshot: {speed} kB/s, {count} slots", {
          speed: parsed.data.kbpersec,
          count: parsed.data.slots.length,
        });
        return { dataHandles: [handle] };
      },
    },
    get_history: {
      description:
        "Fetch recent SABnzbd history entries (completed and failed)",
      arguments: z.object({
        limit: z.number().default(20).describe("Maximum number of entries"),
      }),
      execute: async (
        args: { limit: number },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const raw = await sabnzbdFetch(context.globalArgs, {
          mode: "history",
          limit: String(args.limit),
        });
        const slots = (raw as { history: { slots: unknown[] } }).history.slots;

        const handles = [];
        for (const slot of slots) {
          const parsed = HistorySlotSchema.safeParse(slot);
          if (!parsed.success) continue;
          const handle = await context.writeResource(
            "history_entry",
            parsed.data.nzo_id,
            parsed.data,
          );
          handles.push(handle);
        }
        context.logger.info("Stored {count} history entries", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
    add_nzb_url: {
      description: "Add an NZB to the queue by URL",
      arguments: z.object({
        url: z.string().describe("URL SABnzbd should fetch the .nzb from"),
        name: z.string().optional().describe(
          "Optional display name for the job",
        ),
        category: z.string().optional().describe(
          "Optional category to assign",
        ),
      }),
      execute: async (
        args: { url: string; name?: string; category?: string },
        context: LoggerContext & {
          globalArgs: GlobalArgs;
        },
      ) => {
        context.logger.info("Adding NZB from URL to SABnzbd queue", {});
        const params: Record<string, string> = {
          mode: "addurl",
          name: args.url,
        };
        if (args.name) params.nzbname = args.name;
        if (args.category) params.cat = args.category;

        const raw = await sabnzbdFetch(context.globalArgs, params);
        const nzoIds = (raw as { nzo_ids?: string[] }).nzo_ids ?? [];
        context.logger.info("SABnzbd accepted job: {ids}", {
          ids: nzoIds.join(", "),
        });
        return { dataHandles: [] };
      },
    },
  },
};
