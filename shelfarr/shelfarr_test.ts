/**
 * Unit tests for the shelfarr extension model. Mocks `globalThis.fetch` so
 * no real shim instance is required.
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { model } from "./shelfarr.ts";

const GLOBAL_ARGS = {
  baseUrl: "http://shim.test:8090",
  apiKey: "test-shim-key",
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

Deno.test("upsert_download_client posts to /download-clients and stores the result", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const restore = mockFetch((url, init) => {
    assertStringIncludes(url, "/download-clients");
    capturedBody = JSON.parse(init!.body as string);
    return new Response(
      JSON.stringify({ ok: true, id: 5, name: "SABnzbd", persisted: true }),
      { status: 200 },
    );
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    await model.methods.upsert_download_client.execute(
      {
        name: "SABnzbd",
        client_type: "sabnzbd",
        url: "http://sabnzbd:8080",
        api_key: "some-key",
        priority: 0,
        enabled: true,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    assertEquals(capturedBody?.name, "SABnzbd");
    assertEquals(capturedBody?.client_type, "sabnzbd");
    const written = getWrittenResources();
    assertEquals(written[0].name, "SABnzbd");
    assertEquals(written[0].data.id, 5);
  } finally {
    restore();
  }
});

Deno.test("upsert_download_client sends the shim API key as X-Api-Key", async () => {
  let capturedHeaders: HeadersInit | undefined;
  const restore = mockFetch((_url, init) => {
    capturedHeaders = init?.headers;
    return new Response(
      JSON.stringify({ ok: true, id: 1, name: "x", persisted: true }),
      { status: 200 },
    );
  });

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });
    await model.methods.upsert_download_client.execute(
      {
        name: "x",
        client_type: "sabnzbd",
        url: "http://x",
        priority: 0,
        enabled: true,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    const headers = new Headers(capturedHeaders);
    assertEquals(headers.get("X-Api-Key"), "test-shim-key");
  } finally {
    restore();
  }
});

Deno.test("upsert_acquisition_provider posts to /acquisition-providers and stores the result", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const restore = mockFetch((url, init) => {
    assertStringIncludes(url, "/acquisition-providers");
    capturedBody = JSON.parse(init!.body as string);
    return new Response(
      JSON.stringify({ ok: true, id: 1, name: "Prowlarr", persisted: true }),
      { status: 200 },
    );
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    await model.methods.upsert_acquisition_provider.execute(
      {
        name: "Prowlarr",
        url: "http://prowlarr:9696",
        api_key: "some-key",
        allow_private_network: true,
        supports_audiobooks: true,
        supports_ebooks: true,
        supports_comicbooks: false,
        priority: 0,
        enabled: true,
      },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    assertEquals(capturedBody?.name, "Prowlarr");
    assertEquals(capturedBody?.allow_private_network, true);
    const written = getWrittenResources();
    assertEquals(written[0].name, "Prowlarr");
  } finally {
    restore();
  }
});

Deno.test("update_settings patches /settings with the raw key/value map", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  const restore = mockFetch((url, init) => {
    assertStringIncludes(url, "/settings");
    assertEquals(init?.method, "PATCH");
    capturedBody = JSON.parse(init!.body as string);
    return new Response(
      JSON.stringify({
        ok: true,
        updated: { download_remote_path: "/downloads" },
      }),
      { status: 200 },
    );
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    await model.methods.update_settings.execute(
      { settings: { download_remote_path: "/downloads" } },
      // deno-lint-ignore no-explicit-any
      context as any,
    );

    assertEquals(capturedBody?.download_remote_path, "/downloads");
    const written = getWrittenResources();
    assertEquals(
      (written[0].data.updated as Record<string, string>)
        .download_remote_path,
      "/downloads",
    );
  } finally {
    restore();
  }
});

Deno.test("shimFetch throws a descriptive error on a non-2xx response", async () => {
  const restore = mockFetch(() =>
    new Response("Unauthorized", { status: 401 })
  );

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });

    await assertRejects(
      () =>
        model.methods.update_settings.execute(
          { settings: { key: "value" } },
          // deno-lint-ignore no-explicit-any
          context as any,
        ),
      Error,
      "401",
    );
  } finally {
    restore();
  }
});

Deno.test("shim-reachable check passes when the shim responds", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({ status: "ok" }), { status: 200 })
  );

  try {
    const result = await model.checks["shim-reachable"].execute({
      globalArgs: GLOBAL_ARGS,
    });
    assertEquals(result.pass, true);
  } finally {
    restore();
  }
});

Deno.test("shim-reachable check fails descriptively when unreachable", async () => {
  const restore = mockFetch(() => new Response("Forbidden", { status: 403 }));

  try {
    const result = await model.checks["shim-reachable"].execute({
      globalArgs: GLOBAL_ARGS,
    });
    assertEquals(result.pass, false);
    assertStringIncludes(result.errors![0], "403");
  } finally {
    restore();
  }
});
