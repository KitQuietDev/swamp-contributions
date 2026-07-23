/**
 * Unit tests for the SABnzbd extension model. Mocks `globalThis.fetch` so
 * no real SABnzbd instance is required.
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { model } from "./sabnzbd.ts";

const GLOBAL_ARGS = {
  baseUrl: "http://sabnzbd.test:8080",
  apiKey: "test-sabnzbd-key",
};

function mockFetch(
  handler: (url: string) => Response | Promise<Response>,
) {
  const original = globalThis.fetch;
  globalThis.fetch =
    ((url: string | URL | Request) => handler(url.toString())) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("list_categories writes one resource per category, excluding the wildcard", async () => {
  const restore = mockFetch((url) => {
    assertStringIncludes(url, "/api");
    assertStringIncludes(url, "mode=get_cats");
    return new Response(
      JSON.stringify({ categories: ["*", "movies", "audiobooks"] }),
      { status: 200 },
    );
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    // deno-lint-ignore no-explicit-any
    await model.methods.list_categories.execute({}, context as any);

    const written = getWrittenResources();
    assertEquals(written.length, 2);
    assertEquals(written.map((w) => w.name).sort(), ["audiobooks", "movies"]);
  } finally {
    restore();
  }
});

Deno.test("sabnzbdFetch uses /api, never /sabnzbd/api", async () => {
  const restore = mockFetch((url) => {
    const parsed = new URL(url);
    assertEquals(parsed.pathname, "/api");
    return new Response(JSON.stringify({ categories: ["*"] }), {
      status: 200,
    });
  });

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });
    // deno-lint-ignore no-explicit-any
    await model.methods.list_categories.execute({}, context as any);
  } finally {
    restore();
  }
});

Deno.test("sabnzbdFetch sends apikey and output=json as query params", async () => {
  let capturedUrl: URL | undefined;
  const restore = mockFetch((url) => {
    capturedUrl = new URL(url);
    return new Response(JSON.stringify({ categories: [] }), { status: 200 });
  });

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });
    // deno-lint-ignore no-explicit-any
    await model.methods.list_categories.execute({}, context as any);

    assertEquals(capturedUrl?.searchParams.get("apikey"), "test-sabnzbd-key");
    assertEquals(capturedUrl?.searchParams.get("output"), "json");
  } finally {
    restore();
  }
});

Deno.test("add_category is idempotent — skips the API call if the category already exists", async () => {
  let setConfigCalled = false;
  const restore = mockFetch((url) => {
    const parsed = new URL(url);
    if (parsed.searchParams.get("mode") === "get_cats") {
      return new Response(
        JSON.stringify({ categories: ["*", "audiobooks"] }),
        { status: 200 },
      );
    }
    if (parsed.searchParams.get("mode") === "set_config") {
      setConfigCalled = true;
    }
    return new Response(JSON.stringify({ config: {} }), { status: 200 });
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    await model.methods.add_category.execute(
      { name: "audiobooks", priority: 0 },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    assertEquals(setConfigCalled, false);
    const written = getWrittenResources();
    assertEquals(written[0].name, "audiobooks");
  } finally {
    restore();
  }
});

Deno.test("add_category creates the category when it doesn't exist yet", async () => {
  let setConfigParams: URLSearchParams | undefined;
  const restore = mockFetch((url) => {
    const parsed = new URL(url);
    if (parsed.searchParams.get("mode") === "get_cats") {
      return new Response(JSON.stringify({ categories: ["*"] }), {
        status: 200,
      });
    }
    setConfigParams = parsed.searchParams;
    return new Response(JSON.stringify({ config: {} }), { status: 200 });
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    await model.methods.add_category.execute(
      { name: "new-cat", priority: 5 },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    assertEquals(setConfigParams?.get("section"), "categories");
    assertEquals(setConfigParams?.get("keyword"), "new-cat");
    assertEquals(setConfigParams?.get("value"), "5");
    assertEquals(getWrittenResources()[0].data.priority, 5);
  } finally {
    restore();
  }
});

Deno.test("remove_category deletes the category and its stored resource", async () => {
  const requests: URLSearchParams[] = [];
  const restore = mockFetch((url) => {
    requests.push(new URL(url).searchParams);
    return new Response(JSON.stringify({ status: true }), { status: 200 });
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

    await model.methods.remove_category.execute(
      { name: "old-cat" },
      // deno-lint-ignore no-explicit-any
      contextWithDelete as any,
    );

    assertEquals(requests[0].get("mode"), "del_config");
    assertEquals(requests[0].get("keyword"), "old-cat");
    assertEquals(deletedNames, ["old-cat"]);
  } finally {
    restore();
  }
});

Deno.test("get_queue parses and stores the queue snapshot", async () => {
  const restore = mockFetch(() =>
    new Response(
      JSON.stringify({
        queue: {
          paused: false,
          speed: "1.2 M",
          kbpersec: "1200.00",
          mb: "500.00",
          mbleft: "100.00",
          slots: [{ filename: "test.job" }],
        },
      }),
      { status: 200 },
    )
  );

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    // deno-lint-ignore no-explicit-any
    await model.methods.get_queue.execute({}, context as any);

    const written = getWrittenResources();
    assertEquals(written[0].name, "current");
    assertEquals(written[0].data.kbpersec, "1200.00");
  } finally {
    restore();
  }
});

Deno.test("get_history stores each slot keyed by nzo_id", async () => {
  const restore = mockFetch(() =>
    new Response(
      JSON.stringify({
        history: {
          slots: [
            { name: "Job A", nzo_id: "SABnzbd_nzo_aaa", status: "Completed" },
            {
              name: "Job B",
              nzo_id: "SABnzbd_nzo_bbb",
              status: "Failed",
              fail_message: "Unpacking failed",
            },
          ],
        },
      }),
      { status: 200 },
    )
  );

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    await model.methods.get_history.execute(
      { limit: 20 },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const written = getWrittenResources();
    assertEquals(written.length, 2);
    assertEquals(written[0].name, "SABnzbd_nzo_aaa");
    assertEquals(written[1].data.fail_message, "Unpacking failed");
  } finally {
    restore();
  }
});

Deno.test("add_nzb_url passes name and category through when provided", async () => {
  let capturedParams: URLSearchParams | undefined;
  const restore = mockFetch((url) => {
    capturedParams = new URL(url).searchParams;
    return new Response(
      JSON.stringify({ status: true, nzo_ids: ["SABnzbd_nzo_xyz"] }),
      { status: 200 },
    );
  });

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });

    await model.methods.add_nzb_url.execute(
      {
        url: "http://prowlarr.test:9696/8/download?link=abc",
        name: "My Book",
        category: "audiobooks",
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    assertEquals(capturedParams?.get("mode"), "addurl");
    assertEquals(capturedParams?.get("nzbname"), "My Book");
    assertEquals(capturedParams?.get("cat"), "audiobooks");
  } finally {
    restore();
  }
});

Deno.test("sabnzbdFetch throws on an HTTP-level error", async () => {
  const restore = mockFetch(() =>
    new Response("Unauthorized", { status: 401 })
  );

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });

    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => model.methods.list_categories.execute({}, context as any),
      Error,
      "401",
    );
  } finally {
    restore();
  }
});

Deno.test("sabnzbdFetch throws on a 200-status API-level error payload", async () => {
  // SABnzbd returns HTTP 200 with {"error": "..."} for some failures — the
  // body must be checked, not just response.ok.
  const restore = mockFetch(() =>
    new Response(JSON.stringify({ error: "API Key Incorrect" }), {
      status: 200,
    })
  );

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });

    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => model.methods.list_categories.execute({}, context as any),
      Error,
      "API Key Incorrect",
    );
  } finally {
    restore();
  }
});

Deno.test("sabnzbd-reachable check passes when the API responds", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({ categories: ["*"] }), { status: 200 })
  );

  try {
    const result = await model.checks["sabnzbd-reachable"].execute({
      globalArgs: GLOBAL_ARGS,
    });
    assertEquals(result.pass, true);
  } finally {
    restore();
  }
});

Deno.test("sabnzbd-reachable check fails descriptively when unreachable", async () => {
  const restore = mockFetch(() => new Response("Forbidden", { status: 403 }));

  try {
    const result = await model.checks["sabnzbd-reachable"].execute({
      globalArgs: GLOBAL_ARGS,
    });
    assertEquals(result.pass, false);
    assertStringIncludes(result.errors![0], "403");
  } finally {
    restore();
  }
});
