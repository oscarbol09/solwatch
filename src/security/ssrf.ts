import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NotifierError, ValidationError } from "../domain/errors.js";

export type ResolvedAddress = {
  readonly address: string;
  readonly family: number;
};

export type LookupAllFn = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export type OutboundUrlOptions = {
  readonly allowedProtocols: readonly string[];
  readonly allowPrivateHosts?: boolean | undefined;
  readonly allowCredentials?: boolean | undefined;
  readonly allowedHostnames?: ReadonlySet<string> | undefined;
  readonly requiredPathPrefix?: string | undefined;
};

export const DISCORD_WEBHOOK_HOSTS = new Set<string>([
  "discord.com",
  "ptb.discord.com",
  "canary.discord.com",
  "discordapp.com",
]);

export async function defaultDnsLookup(hostname: string): Promise<readonly ResolvedAddress[]> {
  const entries = await lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => ({
    address: entry.address,
    family: entry.family,
  }));
}

function normalizeHostInput(host: string): string {
  let cleaned = host.trim().toLowerCase();
  if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
    cleaned = cleaned.slice(1, -1);
  }
  const zoneIdx = cleaned.indexOf("%");
  if (zoneIdx >= 0) {
    cleaned = cleaned.slice(0, zoneIdx);
  }
  return cleaned.replace(/\.+$/, "");
}

function parseIpv4Octets(ip: string): readonly [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    return null;
  }
  return [a, b, c, d];
}

function parseIpv6HexParts(segmentStr: string): number[] | null {
  if (segmentStr.length === 0) return [];
  const rawParts = segmentStr.split(":");
  const groups: number[] = [];

  for (let i = 0; i < rawParts.length; i += 1) {
    const part = rawParts[i];
    if (part === undefined || part.length === 0) return null;

    if (part.includes(".")) {
      if (i !== rawParts.length - 1) return null;
      const ipv4 = parseIpv4Octets(part);
      if (!ipv4) return null;
      groups.push(((ipv4[0] << 8) | ipv4[1]) >>> 0);
      groups.push(((ipv4[2] << 8) | ipv4[3]) >>> 0);
      continue;
    }

    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }

  return groups;
}

function parseIpv6Groups(ip: string): readonly number[] | null {
  const lower = normalizeHostInput(ip);
  const dblIdx = lower.indexOf("::");

  if (dblIdx >= 0) {
    if (lower.indexOf("::", dblIdx + 2) >= 0) return null;
    const leftRaw = lower.slice(0, dblIdx);
    const rightRaw = lower.slice(dblIdx + 2);
    const left = parseIpv6HexParts(leftRaw);
    const right = parseIpv6HexParts(rightRaw);
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    return [...left, ...new Array<number>(missing).fill(0), ...right];
  }

  const parts = parseIpv6HexParts(lower);
  if (parts?.length !== 8) return null;
  return parts;
}

function isIpv4OctetsPrivateOrReserved(octets: readonly [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 ("this host on this network")
  if (a === 10) return true; // 10.0.0.0/8 RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT RFC 6598
  if (a === 127) return true; // 127.0.0.0/8 Loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 Link-local & IMDS
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC 1918
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 Benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 Multicast & 240.0.0.0/4 Reserved/Broadcast
  return false;
}

function extractEmbeddedIpv4(g6: number, g7: number): readonly [number, number, number, number] {
  return [(g6 >>> 8) & 0xff, g6 & 0xff, (g7 >>> 8) & 0xff, g7 & 0xff];
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const cleaned = normalizeHostInput(ip);
  const family = isIP(cleaned);

  if (family === 4) {
    const octets = parseIpv4Octets(cleaned);
    return octets === null || isIpv4OctetsPrivateOrReserved(octets);
  }

  if (family === 6) {
    const g = parseIpv6Groups(cleaned);
    if (!g) return true;

    const g0 = g[0] ?? 0;
    const g1 = g[1] ?? 0;
    const g2 = g[2] ?? 0;
    const g3 = g[3] ?? 0;
    const g4 = g[4] ?? 0;
    const g5 = g[5] ?? 0;
    const g6 = g[6] ?? 0;
    const g7 = g[7] ?? 0;

    // Unspecified (::) and loopback (::1)
    if (
      g0 === 0 &&
      g1 === 0 &&
      g2 === 0 &&
      g3 === 0 &&
      g4 === 0 &&
      g5 === 0 &&
      g6 === 0 &&
      g7 <= 1
    ) {
      return true;
    }

    // IPv4-mapped IPv6 (::ffff:0:0/96)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      return isIpv4OctetsPrivateOrReserved(extractEmbeddedIpv4(g6, g7));
    }

    // NAT64 well-known prefix (64:ff9b::/96)
    if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return isIpv4OctetsPrivateOrReserved(extractEmbeddedIpv4(g6, g7));
    }

    // Unique Local Addresses (fc00::/7)
    if ((g0 & 0xfe00) === 0xfc00) {
      return true;
    }

    // Link-local (fe80::/10)
    if ((g0 & 0xffc0) === 0xfe80) {
      return true;
    }

    // Multicast (ff00::/8)
    if ((g0 & 0xff00) === 0xff00) {
      return true;
    }

    // Discard-only prefix (100::/64)
    if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) {
      return true;
    }

    // Documentation prefix (2001:db8::/32)
    if (g0 === 0x2001 && g1 === 0x0db8) {
      return true;
    }

    return false;
  }

  return false;
}

export function isCloudMetadataTarget(hostname: string): boolean {
  const norm = normalizeHostInput(hostname);
  if (
    norm === "metadata.google.internal" ||
    norm === "instance-data" ||
    norm === "169.254.169.254" ||
    norm.startsWith("169.254.")
  ) {
    return true;
  }

  if (isIP(norm) === 6) {
    const g = parseIpv6Groups(norm);
    if (!g) return true;
    const g0 = g[0] ?? 0;
    const g1 = g[1] ?? 0;
    const g2 = g[2] ?? 0;
    const g3 = g[3] ?? 0;
    const g4 = g[4] ?? 0;
    const g5 = g[5] ?? 0;
    const g6 = g[6] ?? 0;
    const g7 = g[7] ?? 0;

    // Link-local fe80::/10 (e.g., AWS/GCP IPv6 metadata endpoints)
    if ((g0 & 0xffc0) === 0xfe80) {
      return true;
    }

    // IPv4-mapped 169.254.0.0/16
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
      const [a, b] = extractEmbeddedIpv4(g6, g7);
      return a === 169 && b === 254;
    }
  }

  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const norm = normalizeHostInput(hostname);
  if (norm.length === 0) return true;
  if (isCloudMetadataTarget(norm)) return true;

  if (
    norm === "localhost" ||
    norm === "ip6-localhost" ||
    norm === "ip6-loopback" ||
    norm.endsWith(".localhost") ||
    norm.endsWith(".local") ||
    norm.endsWith(".internal") ||
    norm.endsWith(".arpa")
  ) {
    return true;
  }

  if (isIP(norm) !== 0) {
    return isPrivateOrReservedIp(norm);
  }

  return false;
}

export function isLoopbackHost(host: string): boolean {
  const norm = normalizeHostInput(host);
  if (norm === "localhost" || norm === "ip6-localhost" || norm === "ip6-loopback") {
    return true;
  }
  const family = isIP(norm);
  if (family === 4) {
    const octets = parseIpv4Octets(norm);
    return octets !== null && octets[0] === 127;
  }
  if (family === 6) {
    const g = parseIpv6Groups(norm);
    if (!g) return false;
    return (
      g[0] === 0 &&
      g[1] === 0 &&
      g[2] === 0 &&
      g[3] === 0 &&
      g[4] === 0 &&
      g[5] === 0 &&
      g[6] === 0 &&
      g[7] === 1
    );
  }
  return false;
}

export function validateOutboundUrl(rawUrl: string, options: OutboundUrlOptions): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new ValidationError("Invalid URL syntax");
  }

  if (!options.allowedProtocols.includes(parsed.protocol)) {
    throw new ValidationError(`URL protocol "${parsed.protocol}" is not allowed`);
  }

  if (!options.allowCredentials && (parsed.username.length > 0 || parsed.password.length > 0)) {
    throw new ValidationError("URL credentials are not allowed");
  }

  if (isCloudMetadataTarget(parsed.hostname)) {
    throw new ValidationError("Cloud metadata hosts are forbidden");
  }

  if (!options.allowPrivateHosts && isBlockedHostname(parsed.hostname)) {
    throw new ValidationError("URL target host is private or reserved");
  }

  if (options.allowedHostnames) {
    const normalizedHost = normalizeHostInput(parsed.hostname);
    if (!options.allowedHostnames.has(normalizedHost)) {
      throw new ValidationError("URL hostname is not in the configured allowlist");
    }
  }

  if (options.requiredPathPrefix && !parsed.pathname.startsWith(options.requiredPathPrefix)) {
    throw new ValidationError("URL path does not match required prefix");
  }

  return parsed;
}

export function validateDiscordWebhookUrl(rawUrl: string): URL {
  const parsed = validateOutboundUrl(rawUrl, {
    allowedProtocols: ["https:"],
    allowPrivateHosts: false,
    allowCredentials: false,
    allowedHostnames: DISCORD_WEBHOOK_HOSTS,
    requiredPathPrefix: "/api/webhooks/",
  });

  const segments = parsed.pathname.split("/").filter((part) => part.length > 0);
  if (segments.length < 4 || segments[0] !== "api" || segments[1] !== "webhooks") {
    throw new ValidationError("Discord webhook URL must include webhook ID and token");
  }

  return parsed;
}

export async function assertResolvedHostPublic(
  hostname: string,
  lookupFn: LookupAllFn = defaultDnsLookup,
): Promise<readonly string[]> {
  const normalized = normalizeHostInput(hostname);
  if (isBlockedHostname(normalized)) {
    throw new NotifierError("webhook", "Outbound target host is blocked by SSRF policy", {
      retryable: false,
    });
  }

  if (isIP(normalized) !== 0) {
    return [normalized];
  }

  let entries: readonly ResolvedAddress[];
  try {
    entries = await lookupFn(normalized);
  } catch (err) {
    throw new NotifierError("webhook", "Failed to resolve outbound webhook host", {
      retryable: true,
      cause: err,
    });
  }

  if (entries.length === 0) {
    throw new NotifierError("webhook", "Outbound webhook host returned no DNS records", {
      retryable: true,
    });
  }

  for (const entry of entries) {
    if (isPrivateOrReservedIp(entry.address)) {
      throw new NotifierError(
        "webhook",
        "Outbound webhook target resolved to a private or reserved IP address",
        { retryable: false },
      );
    }
  }

  return entries.map((entry) => entry.address);
}
