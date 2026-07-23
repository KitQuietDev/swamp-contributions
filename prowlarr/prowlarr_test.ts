/**
 * Unit tests for the Prowlarr extension model. Mocks `globalThis.fetch` so
 * no real Prowlarr instance is required.
 *
 * createModelTestContext()'s MethodContext types globalArgs as
 * Record<string, unknown> and does not implement deleteResource — both are
 * narrower/thinner than the real runtime context this model was already
 * verified against live (see session notes). `as any` at the execute()
 * call-site and a manually-injected deleteResource stub bridge that gap
 * without weakening the model's own inline typing.
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { model } from "./prowlarr.ts";

const GLOBAL_ARGS = {
  baseUrl: "http://prowlarr.test:9696",
  apiKey: "test-prowlarr-key",
};

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const original = globalThis.fetch;
  globalThis.fetch =
    ((url: string | URL | Request, init?: RequestInit) =>
      handler(url.toString(), init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("list_indexers writes one resource per indexer", async () => {
  const restore = mockFetch((url) => {
    assertStringIncludes(url, "/api/v1/indexer");
    return new Response(
      JSON.stringify([
        {
          id: 1,
          name: "Alpha",
          enable: true,
          protocol: "torrent",
          priority: 25,
          implementation: "Torznab",
        },
        {
          id: 2,
          name: "Beta",
          enable: false,
          protocol: "usenet",
          priority: 25,
          implementation: "Newznab",
        },
      ]),
      { status: 200 },
    );
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    // deno-lint-ignore no-explicit-any
    await model.methods.list_indexers.execute({}, context as any);

    const written = getWrittenResources();
    assertEquals(written.length, 2);
    assertEquals(written[0].name, "indexer-1");
    assertEquals(written[0].data.name, "Alpha");
    assertEquals(written[1].name, "indexer-2");
    assertEquals(written[1].data.enable, false);
  } finally {
    restore();
  }
});

Deno.test("list_indexers sends the API key as X-Api-Key, not in the URL", async () => {
  let capturedHeaders: HeadersInit | undefined;
  const restore = mockFetch((_url, init) => {
    capturedHeaders = init?.headers;
    return new Response(JSON.stringify([]), { status: 200 });
  });

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });
    // deno-lint-ignore no-explicit-any
    await model.methods.list_indexers.execute({}, context as any);

    const headers = new Headers(capturedHeaders);
    assertEquals(headers.get("X-Api-Key"), "test-prowlarr-key");
  } finally {
    restore();
  }
});

Deno.test("add_torznab_indexer fills the Generic Torznab template and posts it", async () => {
  const schemaResponse = [
    { name: "Generic Newznab", fields: [] },
    {
      name: "Generic Torznab",
      appProfileId: 0,
      fields: [
        { name: "baseUrl", value: "" },
        { name: "apiPath", value: "/api" },
        { name: "apiKey", value: "" },
      ],
    },
  ];

  let postedBody: Record<string, unknown> | undefined;
  const restore = mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && !url.includes("/schema")) {
      // Existence check — nothing exists yet.
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (method === "GET" && url.includes("/schema")) {
      assertStringIncludes(url, "/api/v1/indexer/schema");
      return new Response(JSON.stringify(schemaResponse), { status: 200 });
    }
    if (method === "POST") {
      assertStringIncludes(url, "/api/v1/indexer");
      const parsed = JSON.parse(init!.body as string) as Record<
        string,
        unknown
      >;
      postedBody = parsed;
      return new Response(
        JSON.stringify({
          id: 42,
          name: parsed.name,
          enable: true,
          protocol: "torrent",
          priority: 25,
          implementation: "Torznab",
        }),
        { status: 201 },
      );
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    const result = await model.methods.add_torznab_indexer.execute(
      {
        name: "Jackett - AudiobookBay",
        siteBaseUrl: "http://jackett:9117",
        apiPath: "/api/v2.0/indexers/audiobookbay/results/torznab",
        siteApiKey: "jackett-key-123",
        appProfileId: 1,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    assertEquals(postedBody?.name, "Jackett - AudiobookBay");
    assertEquals(postedBody?.appProfileId, 1);
    assertEquals(postedBody?.id, undefined);
    assertEquals(postedBody?.infoLink, undefined);

    const fields = postedBody?.fields as Array<
      { name: string; value: string }
    >;
    assertEquals(
      fields.find((f) => f.name === "baseUrl")?.value,
      "http://jackett:9117",
    );
    assertEquals(
      fields.find((f) => f.name === "apiPath")?.value,
      "/api/v2.0/indexers/audiobookbay/results/torznab",
    );
    assertEquals(
      fields.find((f) => f.name === "apiKey")?.value,
      "jackett-key-123",
    );

    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].name, "indexer-42");
    assertEquals(result.dataHandles?.length, 1);
  } finally {
    restore();
  }
});

Deno.test("add_torznab_indexer is idempotent — skips creation if the name already exists", async () => {
  let postRequested = false;
  const restore = mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && !url.includes("/schema")) {
      return new Response(
        JSON.stringify([
          {
            id: 99,
            name: "Jackett - AudiobookBay",
            enable: true,
            protocol: "torrent",
            priority: 25,
            implementation: "Torznab",
          },
        ]),
        { status: 200 },
      );
    }
    if (method === "POST") {
      postRequested = true;
    }
    throw new Error(`Unexpected request in idempotency test: ${method} ${url}`);
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    const result = await model.methods.add_torznab_indexer.execute(
      {
        name: "Jackett - AudiobookBay",
        siteBaseUrl: "http://jackett:9117",
        apiPath: "/api/v2.0/indexers/audiobookbay/results/torznab",
        siteApiKey: "jackett-key-123",
        appProfileId: 1,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    assertEquals(postRequested, false);
    const written = getWrittenResources();
    assertEquals(written.length, 1);
    assertEquals(written[0].name, "indexer-99");
    assertEquals(result.dataHandles?.length, 1);
  } finally {
    restore();
  }
});

Deno.test("add_torznab_indexer throws if Prowlarr has no Generic Torznab template", async () => {
  const restore = mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && !url.includes("/schema")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });

    await assertRejects(
      () =>
        model.methods.add_torznab_indexer.execute(
          {
            name: "x",
            siteBaseUrl: "http://x",
            apiPath: "/api",
            siteApiKey: "k",
            appProfileId: 1,
          },
          // deno-lint-ignore no-explicit-any
          context as any,
        ),
      Error,
      "Generic Torznab",
    );
  } finally {
    restore();
  }
});

Deno.test("update_indexer reads current state, merges changes, and PUTs the result", async () => {
  let putBody: Record<string, unknown> | undefined;
  const restore = mockFetch((url, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      assertStringIncludes(url, "/api/v1/indexer/8");
      return new Response(
        JSON.stringify({
          id: 8,
          name: "DrunkenSlug",
          enable: true,
          protocol: "usenet",
          priority: 25,
          implementation: "Newznab",
          appProfileId: 1,
        }),
        { status: 200 },
      );
    }
    if (method === "PUT") {
      assertStringIncludes(url, "/api/v1/indexer/8");
      const parsed = JSON.parse(init!.body as string) as Record<
        string,
        unknown
      >;
      putBody = parsed;
      return new Response(JSON.stringify(parsed), { status: 202 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    await model.methods.update_indexer.execute(
      { indexerId: 8, enable: false },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    // Untouched fields carry through unchanged.
    assertEquals(putBody?.name, "DrunkenSlug");
    assertEquals(putBody?.priority, 25);
    // The requested change is applied.
    assertEquals(putBody?.enable, false);

    const written = getWrittenResources();
    assertEquals(written[0].name, "indexer-8");
    assertEquals(written[0].data.enable, false);
  } finally {
    restore();
  }
});

Deno.test("sync_indexer refreshes stored state from the live API", async () => {
  const restore = mockFetch(() =>
    new Response(
      JSON.stringify({
        id: 3,
        name: "TheRARBG",
        enable: true,
        protocol: "torrent",
        priority: 30,
        implementation: "Torznab",
      }),
      { status: 200 },
    )
  );

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    await model.methods.sync_indexer.execute(
      { indexerId: 3 },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const written = getWrittenResources();
    assertEquals(written[0].name, "indexer-3");
    assertEquals(written[0].data.priority, 30);
  } finally {
    restore();
  }
});

Deno.test("sync_indexer writes a not_found marker instead of throwing when the indexer is gone", async () => {
  const restore = mockFetch(() => new Response("Not Found", { status: 404 }));

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    await model.methods.sync_indexer.execute(
      { indexerId: 99 },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const written = getWrittenResources();
    assertEquals(written[0].name, "indexer-99");
    assertEquals(written[0].data.status, "not_found");
  } finally {
    restore();
  }
});

Deno.test("remove_indexer deletes the indexer and its stored resource", async () => {
  const requests: Array<{ url: string; method?: string }> = [];
  const restore = mockFetch((url, init) => {
    requests.push({ url, method: init?.method });
    return new Response(null, { status: 204 });
  });

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });
    const deletedNames: string[] = [];
    const contextWithDelete = {
      ...context,
      deleteResource: (instanceName: string) => {
        deletedNames.push(instanceName);
        return Promise.resolve();
      },
    };

    await model.methods.remove_indexer.execute(
      { indexerId: 7 },
      // deno-lint-ignore no-explicit-any
      contextWithDelete as any,
    );

    assertEquals(requests.length, 1);
    assertEquals(requests[0].method, "DELETE");
    assertStringIncludes(requests[0].url, "/api/v1/indexer/7");
    assertEquals(deletedNames, ["indexer-7"]);
  } finally {
    restore();
  }
});

Deno.test("remove_indexer succeeds when the indexer is already gone (404)", async () => {
  const restore = mockFetch(() => new Response("Not Found", { status: 404 }));

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });
    const deletedNames: string[] = [];
    const contextWithDelete = {
      ...context,
      deleteResource: (instanceName: string) => {
        deletedNames.push(instanceName);
        return Promise.resolve();
      },
    };

    // Should NOT throw — already gone counts as success for a delete.
    await model.methods.remove_indexer.execute(
      { indexerId: 7 },
      // deno-lint-ignore no-explicit-any
      contextWithDelete as any,
    );

    assertEquals(deletedNames, ["indexer-7"]);
  } finally {
    restore();
  }
});

Deno.test("remove_indexer still throws on non-404 errors", async () => {
  const restore = mockFetch(() =>
    new Response("Internal Server Error", { status: 500 })
  );

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });
    const contextWithDelete = {
      ...context,
      deleteResource: () => Promise.resolve(),
    };

    await assertRejects(
      () =>
        model.methods.remove_indexer.execute(
          { indexerId: 7 },
          // deno-lint-ignore no-explicit-any
          contextWithDelete as any,
        ),
      Error,
      "500",
    );
  } finally {
    restore();
  }
});

Deno.test("prowlarr-reachable check passes when the API responds", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify([]), { status: 200 })
  );

  try {
    const result = await model.checks["prowlarr-reachable"].execute(
      { globalArgs: GLOBAL_ARGS },
    );
    assertEquals(result.pass, true);
  } finally {
    restore();
  }
});

Deno.test("prowlarr-reachable check fails with a descriptive error when unreachable", async () => {
  const restore = mockFetch(() => new Response("Forbidden", { status: 403 }));

  try {
    const result = await model.checks["prowlarr-reachable"].execute(
      { globalArgs: GLOBAL_ARGS },
    );
    assertEquals(result.pass, false);
    assertStringIncludes(result.errors![0], "403");
  } finally {
    restore();
  }
});

Deno.test("prowlarrFetch throws a descriptive error on a non-2xx response", async () => {
  const restore = mockFetch(() =>
    new Response("Unauthorized", { status: 401 })
  );

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });

    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => model.methods.list_indexers.execute({}, context as any),
      Error,
      "401",
    );
  } finally {
    restore();
  }
});
