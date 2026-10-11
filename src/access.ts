import { networkInterfaces } from "node:os";
import type { Access } from "./core/types.ts";
import type { Run } from "./ports.ts";

/**
 * Expands an IPv6 address string into 8 16-bit integer hextets, or returns null if invalid.
 */
export function expandIPv6(addr: string): number[] | null {
  if (addr.includes(".")) return null;
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  let blocks: string[];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    blocks = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    blocks = addr.split(":");
  }
  if (blocks.length !== 8) return null;
  const numbers: number[] = [];
  for (const b of blocks) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(b)) return null;
    numbers.push(parseInt(b, 16));
  }
  return numbers;
}

/**
 * Checks if an IP address string is a loopback address (IPv4 127.0.0.0/8, IPv6 ::1, or IPv4-mapped).
 */
export function isLoopbackAddress(addr: string): boolean {
  let clean = addr;
  if (clean.startsWith("[") && clean.endsWith("]")) clean = clean.slice(1, -1);
  if (clean.startsWith("::ffff:")) clean = clean.slice("::ffff:".length);
  if (clean === "::1" || clean === "0:0:0:0:0:0:0:1") return true;
  if (clean.startsWith("127.")) {
    const parts = clean.split(".");
    if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if an IPv4 address is in Tailscale's CGNAT range (100.64.0.0/10).
 */
export function isTailscaleIPv4(addr: string): boolean {
  let clean = addr;
  if (clean.startsWith("::ffff:")) clean = clean.slice("::ffff:".length);
  if (!clean.startsWith("100.")) return false;
  const parts = clean.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
    return false;
  }
  const b2 = Number(parts[1]);
  return b2 >= 64 && b2 <= 127;
}

/**
 * Checks if an IPv6 address is in Tailscale's ULA range (fd7a:115c:a1e0::/48).
 */
export function isTailscaleIPv6(addr: string): boolean {
  let clean = addr;
  if (clean.startsWith("[") && clean.endsWith("]")) clean = clean.slice(1, -1);
  const parts = expandIPv6(clean);
  if (!parts) return false;
  return parts[0] === 0xfd7a && parts[1] === 0x115c && parts[2] === 0xa1e0;
}

/**
 * Checks if an address is a Tailscale IP (IPv4 100.64.0.0/10 or IPv6 fd7a:115c:a1e0::/48).
 */
export function isTailscaleAddress(addr: string): boolean {
  return isTailscaleIPv4(addr) || isTailscaleIPv6(addr);
}

/**
 * Validates incoming remote address according to the board's access policy:
 * - "network": accepts any remote address
 * - "local": accepts loopback only
 * - "tailscale": accepts loopback and Tailscale peers (100.64.0.0/10, fd7a:115c:a1e0::/48)
 */
export function isAllowedRemoteAddress(remoteAddress: string | undefined, access: Access): boolean {
  if (!remoteAddress) return false;
  if (access === "network") return true;
  if (isLoopbackAddress(remoteAddress)) return true;
  if (access === "tailscale") return isTailscaleAddress(remoteAddress);
  return false;
}

/**
 * Classifies a URL's host for operator display: "this machine", "Tailscale", or "network".
 */
export function urlLabel(urlStr: string): "this machine" | "Tailscale" | "network" {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();
    if (isLoopbackAddress(host) || host === "localhost") return "this machine";
    if (isTailscaleAddress(host) || host.endsWith(".ts.net") || host.endsWith(".ts.net.")) return "Tailscale";
    return "network";
  } catch {
    return "network";
  }
}

/**
 * Formats a list of URLs with labels for CLI / extension notification output.
 */
export function formatUrls(urls: string[]): string {
  if (urls.length === 0) return "";
  const lines: string[] = [];
  for (const u of urls) {
    const label = urlLabel(u);
    const padded = label === "this machine" ? "this machine:" : label === "Tailscale" ? "Tailscale:   " : "network:     ";
    lines.push(`  ${padded} ${u}`);
  }
  return lines.join("\n");
}

export interface ResolveUrlsOptions {
  port: number;
  token: string;
  access: Access;
  run?: Run;
}

/**
 * Discovers and builds accessible URLs for the board in current access mode.
 */
export async function resolveBoardUrls(options: ResolveUrlsOptions): Promise<string[]> {
  const { port, token, access, run } = options;
  const urls: string[] = [];
  const loopbackUrl = `http://127.0.0.1:${port}/#${token}`;
  urls.push(loopbackUrl);

  if (access === "tailscale" || access === "network") {
    // 1. Interfaces in 100.64.0.0/10
    const ifaces = networkInterfaces();
    for (const entries of Object.values(ifaces)) {
      for (const entry of entries ?? []) {
        if (entry.family === "IPv4" && isTailscaleIPv4(entry.address)) {
          urls.push(`http://${entry.address}:${port}/#${token}`);
        }
      }
    }

    // 2. Query MagicDNS and Tailscale IPs via run if available
    if (run) {
      try {
        const result = await run("tailscale", ["status", "--json"], process.cwd());
        if (result.code === 0 && result.stdout) {
          const status = JSON.parse(result.stdout) as {
            Self?: { DNSName?: string; TailscaleIPs?: string[] };
          };
          if (status.Self?.DNSName) {
            const dns = status.Self.DNSName.replace(/\.$/, "");
            if (dns) urls.push(`http://${dns}:${port}/#${token}`);
          }
          if (Array.isArray(status.Self?.TailscaleIPs)) {
            for (const ip of status.Self.TailscaleIPs) {
              if (isTailscaleIPv4(ip)) {
                urls.push(`http://${ip}:${port}/#${token}`);
              }
            }
          }
        }
      } catch {
        // Ignored: tailscale binary might not exist or failed
      }
    }
  }

  if (access === "network") {
    // LAN URLs
    const ifaces = networkInterfaces();
    for (const entries of Object.values(ifaces)) {
      for (const entry of entries ?? []) {
        if (entry.family === "IPv4" && !entry.internal && !isLoopbackAddress(entry.address) && !isTailscaleIPv4(entry.address)) {
          urls.push(`http://${entry.address}:${port}/#${token}`);
        }
      }
    }
  }

  // Deduplicate while preserving order
  return [...new Set(urls)];
}
