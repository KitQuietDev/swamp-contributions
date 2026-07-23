/**
 * Unit tests for the qBittorrent extension model. Mocks `globalThis.fetch`
 * so no real qBittorrent instance is required.
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { model } from "./qbittorrent.ts";

const GLOBAL_ARGS = {
  baseUrl: "http://qbittorrent.test:8080",
  username: "test-user",
  password: "test-pass",
};

function loginResponse(ok = true): Response {
  return new Response(ok ? "Ok." : "Fails.", {
    status: 200,
    headers: ok ? { "set-cookie": "SID=abc123; path=/" } : {},
  });
}

/** Mocks the login call first, then delegates subsequent calls to `handler`. */
function mockFetchWithLogin(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  loginOk = true,
) {
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    call++;
    const urlStr = url.toString();
    if (urlStr.includes("/auth/login")) {
      return loginResponse(loginOk);
    }
    return await handler(urlStr, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    return call;
  };
}

Deno.test("login sends credentials and extracts the SID cookie", async () => {
  let capturedBody: string | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (url.toString().includes("/auth/login")) {
      capturedBody = init?.body?.toString();
      return loginResponse(true);
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });
    // deno-lint-ignore no-explicit-any
    await model.methods.list_categories.execute({}, context as any);

    assertStringIncludes(capturedBody ?? "", "username=test-user");
    assertStringIncludes(capturedBody ?? "", "password=test-pass");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("login throws when the response body is not 'Ok.'", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => loginResponse(false)) as unknown as typeof fetch;

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });

    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => model.methods.list_categories.execute({}, context as any),
      Error,
      "rejected",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("list_categories parses the category map into individual resources", async () => {
  const restore = mockFetchWithLogin(() =>
    new Response(
      JSON.stringify({
        movies: { name: "movies", savePath: "/downloads/movies" },
        audiobooks: { name: "audiobooks", savePath: "/downloads/audiobooks" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  );

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    // deno-lint-ignore no-explicit-any
    await model.methods.list_categories.execute({}, context as any);

    const written = getWrittenResources();
    assertEquals(written.length, 2);
    assertEquals(written.map((w) => w.name).sort(), [
      "audiobooks",
      "movies",
    ]);
  } finally {
    restore();
  }
});

Deno.test("add_category is idempotent — skips the createCategory call if it already exists", async () => {
  let createCalled = false;
  const restore = mockFetchWithLogin((url) => {
    if (url.includes("/categories") && !url.includes("createCategory")) {
      return new Response(
        JSON.stringify({ audiobooks: { name: "audiobooks", savePath: "" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    createCalled = true;
    return new Response("", { status: 200 });
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    await model.methods.add_category.execute(
      { name: "audiobooks", savePath: "" },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    assertEquals(createCalled, false);
    assertEquals(getWrittenResources()[0].name, "audiobooks");
  } finally {
    restore();
  }
});

Deno.test("add_category creates the category when it doesn't exist yet", async () => {
  let capturedBody: string | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    if (urlStr.includes("/auth/login")) return loginResponse(true);
    if (urlStr.includes("createCategory")) {
      capturedBody = init?.body?.toString();
      return new Response("", { status: 200 });
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    await model.methods.add_category.execute(
      { name: "new-cat", savePath: "/downloads/new-cat" },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    assertStringIncludes(capturedBody ?? "", "category=new-cat");
    assertEquals(getWrittenResources()[0].data.savePath, "/downloads/new-cat");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("remove_category posts the category name and deletes the stored resource", async () => {
  let capturedBody: string | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    if (urlStr.includes("/auth/login")) return loginResponse(true);
    capturedBody = init?.body?.toString();
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

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

    assertStringIncludes(capturedBody ?? "", "categories=old-cat");
    assertEquals(deletedNames, ["old-cat"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("test_connection reports connected=true on a successful login", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => loginResponse(true)) as unknown as typeof fetch;

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    // deno-lint-ignore no-explicit-any
    await model.methods.test_connection.execute({}, context as any);

    assertEquals(getWrittenResources()[0].data.connected, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("test_connection reports connected=false, does not throw, on a failed login", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => loginResponse(false)) as unknown as typeof fetch;

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    // deno-lint-ignore no-explicit-any
    await model.methods.test_connection.execute({}, context as any);

    assertEquals(getWrittenResources()[0].data.connected, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("qbittorrent-reachable check passes on successful login", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => loginResponse(true)) as unknown as typeof fetch;

  try {
    const result = await model.checks["qbittorrent-reachable"].execute({
      globalArgs: GLOBAL_ARGS,
    });
    assertEquals(result.pass, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("qbittorrent-reachable check fails descriptively on bad credentials", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => loginResponse(false)) as unknown as typeof fetch;

  try {
    const result = await model.checks["qbittorrent-reachable"].execute({
      globalArgs: GLOBAL_ARGS,
    });
    assertEquals(result.pass, false);
    assertStringIncludes(result.errors![0], "rejected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
