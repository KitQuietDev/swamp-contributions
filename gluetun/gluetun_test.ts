/**
 * Unit tests for the gluetun extension model. Mocks `globalThis.fetch` so
 * no real gluetun instance is required.
 *
 * @module
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260706.24";
import { model } from "./gluetun.ts";

const GLOBAL_ARGS = {
  baseUrl: "http://gluetun.test:8000",
  apiKey: "test-gluetun-key",
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

Deno.test("get_vpn_status calls /v1/vpn/status, not the OpenVPN-specific endpoint", async () => {
  const restore = mockFetch((url) => {
    assertStringIncludes(url, "/v1/vpn/status");
    return new Response(JSON.stringify({ status: "running" }), {
      status: 200,
    });
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    // deno-lint-ignore no-explicit-any
    await model.methods.get_vpn_status.execute({}, context as any);

    const written = getWrittenResources();
    assertEquals(written[0].name, "current");
    assertEquals(written[0].data.status, "running");
  } finally {
    restore();
  }
});

Deno.test("get_vpn_status sends the API key as X-Api-Key", async () => {
  let capturedHeaders: HeadersInit | undefined;
  const restore = mockFetch((_url, init) => {
    capturedHeaders = init?.headers;
    return new Response(JSON.stringify({ status: "running" }), {
      status: 200,
    });
  });

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });
    // deno-lint-ignore no-explicit-any
    await model.methods.get_vpn_status.execute({}, context as any);

    const headers = new Headers(capturedHeaders);
    assertEquals(headers.get("X-Api-Key"), "test-gluetun-key");
  } finally {
    restore();
  }
});

Deno.test("get_public_ip parses and stores the public IP payload", async () => {
  const restore = mockFetch((url) => {
    assertStringIncludes(url, "/v1/publicip/ip");
    return new Response(
      JSON.stringify({
        public_ip: "203.0.113.5",
        country: "Switzerland",
        city: "Zurich",
      }),
      { status: 200 },
    );
  });

  try {
    const { context, getWrittenResources } = createModelTestContext({
      globalArgs: GLOBAL_ARGS,
    });

    // deno-lint-ignore no-explicit-any
    await model.methods.get_public_ip.execute({}, context as any);

    const written = getWrittenResources();
    assertEquals(written[0].data.public_ip, "203.0.113.5");
    assertEquals(written[0].data.country, "Switzerland");
  } finally {
    restore();
  }
});

Deno.test("gluetunFetch throws a descriptive error on a non-2xx response", async () => {
  const restore = mockFetch(() =>
    new Response("Unauthorized", { status: 401 })
  );

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });

    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => model.methods.get_vpn_status.execute({}, context as any),
      Error,
      "401",
    );
  } finally {
    restore();
  }
});

Deno.test("get_vpn_status throws a clear error if the response shape doesn't match", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 })
  );

  try {
    const { context } = createModelTestContext({ globalArgs: GLOBAL_ARGS });

    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => model.methods.get_vpn_status.execute({}, context as any),
      Error,
      "didn't match the expected shape",
    );
  } finally {
    restore();
  }
});

Deno.test("gluetun-reachable check passes when the API responds", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({ status: "running" }), { status: 200 })
  );

  try {
    const result = await model.checks["gluetun-reachable"].execute({
      globalArgs: GLOBAL_ARGS,
    });
    assertEquals(result.pass, true);
  } finally {
    restore();
  }
});

Deno.test("gluetun-reachable check fails descriptively when unreachable", async () => {
  const restore = mockFetch(() => new Response("Forbidden", { status: 403 }));

  try {
    const result = await model.checks["gluetun-reachable"].execute({
      globalArgs: GLOBAL_ARGS,
    });
    assertEquals(result.pass, false);
    assertStringIncludes(result.errors![0], "403");
  } finally {
    restore();
  }
});
