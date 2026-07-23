/**
 * Gluetun manager — VPN status and public IP visibility via gluetun's HTTP
 * control server. Read-only by design: gluetun's own control API can also
 * change VPN state and port forwarding, but this extension deliberately
 * only exposes status/visibility methods, matching a narrowly-scoped API
 * key role rather than a broad one. The API key should always be supplied
 * as a vault CEL expression (`${{ vault.get(vault-name, key) }}`) at
 * model-instance creation time, never as a literal string, so the raw
 * value is resolved by swamp's runtime and never has to pass through an
 * agent's hands.
 *
 * Note on endpoints: gluetun exposes both `/v1/openvpn/status` (OpenVPN-
 * specific) and `/v1/vpn/status` (protocol-agnostic). This extension uses
 * the latter deliberately — on a WireGuard-based setup, the OpenVPN-
 * specific endpoint reports "stopped" even when the tunnel is genuinely
 * up, which would be actively misleading.
 *
 * @module
 */
// extensions/models/gluetun-ext/gluetun.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  baseUrl: z.string().describe(
    "Gluetun control server base URL, e.g. http://localhost:8001. Not " +
      "published to the host by default — check the compose file's ports " +
      "before assuming reachability.",
  ),
  apiKey: z.string().meta({ sensitive: true }).describe(
    "Gluetun control server API key (X-Api-Key header). Requires a " +
      "role configured in gluetun's own auth config.toml with auth = " +
      '"apikey" — gluetun\'s control server has no authentication ' +
      "enabled by default. Supply via a vault expression " +
      "(${{ vault.get(vault-name, key) }}) — never a literal value.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const VpnStatusSchema = z.object({
  status: z.string(),
});
type VpnStatusData = z.infer<typeof VpnStatusSchema>;

const PublicIpSchema = z.object({
  public_ip: z.string(),
  country: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  organization: z.string().optional(),
}).passthrough();
type PublicIpData = z.infer<typeof PublicIpSchema>;

/** Thrown for a non-2xx response from gluetun's control server. */
class GluetunApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GluetunApiError";
  }
}

/** Call gluetun's control server API, throwing {@link GluetunApiError} on any non-2xx response. */
async function gluetunFetch(
  globalArgs: GlobalArgs,
  path: string,
): Promise<unknown> {
  const response = await fetch(`${globalArgs.baseUrl}${path}`, {
    headers: { "X-Api-Key": globalArgs.apiKey },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new GluetunApiError(
      response.status,
      `Gluetun API error ${response.status} [GET ${path}]: ${
        text.slice(0, 500)
      }`,
    );
  }
  return await response.json();
}

type LoggerContext = {
  logger: { info(msg: string, ...args: unknown[]): void };
};

/** Gluetun manager: VPN status and public IP visibility (read-only). */
export const model = {
  type: "@kitquiet/gluetun",
  version: "2026.07.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "vpn_status": {
      description: "Gluetun's protocol-agnostic VPN connection status",
      schema: VpnStatusSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    "public_ip": {
      description: "The public IP address as seen through the VPN tunnel",
      schema: PublicIpSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
  },
  checks: {
    "gluetun-reachable": {
      description:
        "Confirm gluetun's control server is reachable and the API key authenticates",
      labels: ["live"],
      appliesTo: ["get_vpn_status", "get_public_ip"],
      execute: async (
        context: { globalArgs: GlobalArgs },
      ) => {
        try {
          await gluetunFetch(context.globalArgs, "/v1/vpn/status");
          return { pass: true };
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          return {
            pass: false,
            errors: [
              `Could not reach gluetun's control server at ${context.globalArgs.baseUrl}: ${message}`,
            ],
          };
        }
      },
    },
  },
  methods: {
    get_vpn_status: {
      description:
        "Fetch gluetun's protocol-agnostic VPN status (not the OpenVPN-specific endpoint, which misreports on WireGuard setups)",
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
        const raw = await gluetunFetch(context.globalArgs, "/v1/vpn/status");
        const parsed = VpnStatusSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            `Gluetun returned a VPN status that didn't match the expected shape: ${
              parsed.error.message.slice(0, 500)
            }`,
          );
        }

        const handle = await context.writeResource(
          "vpn_status",
          "current",
          parsed.data,
        );
        context.logger.info("VPN status: {status}", {
          status: parsed.data.status,
        });
        return { dataHandles: [handle] };
      },
    },
    get_public_ip: {
      description: "Fetch the public IP address as seen through the VPN tunnel",
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
        const raw = await gluetunFetch(context.globalArgs, "/v1/publicip/ip");
        const parsed = PublicIpSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            `Gluetun returned a public IP payload that didn't match the expected shape: ${
              parsed.error.message.slice(0, 500)
            }`,
          );
        }

        const handle = await context.writeResource(
          "public_ip",
          "current",
          parsed.data,
        );
        context.logger.info("Public IP: {ip} ({country})", {
          ip: parsed.data.public_ip,
          country: parsed.data.country ?? "unknown",
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
