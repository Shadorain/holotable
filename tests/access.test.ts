import { describe, expect, test } from "bun:test";
import {
  formatUrls,
  isAllowedRemoteAddress,
  isLoopbackAddress,
  isTailscaleAddress,
  isTailscaleIPv4,
  isTailscaleIPv6,
  resolveBoardUrls,
  urlLabel,
} from "../src/access.ts";
import type { Run } from "../src/ports.ts";

describe("access filters", () => {
  describe("isLoopbackAddress", () => {
    test("accepts IPv4 loopback", () => {
      expect(isLoopbackAddress("127.0.0.1")).toBe(true);
      expect(isLoopbackAddress("127.0.0.2")).toBe(true);
      expect(isLoopbackAddress("127.255.255.254")).toBe(true);
    });

    test("accepts IPv6 loopback", () => {
      expect(isLoopbackAddress("::1")).toBe(true);
      expect(isLoopbackAddress("0:0:0:0:0:0:0:1")).toBe(true);
    });

    test("accepts IPv4-mapped IPv6 loopback", () => {
      expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
      expect(isLoopbackAddress("::ffff:127.1.2.3")).toBe(true);
    });

    test("rejects non-loopback addresses", () => {
      expect(isLoopbackAddress("100.64.0.1")).toBe(false);
      expect(isLoopbackAddress("192.168.1.1")).toBe(false);
      expect(isLoopbackAddress("10.0.0.1")).toBe(false);
      expect(isLoopbackAddress("::")).toBe(false);
    });
  });

  describe("Tailscale 100.64.0.0/10 boundaries", () => {
    test("accepts within 100.64/10", () => {
      expect(isTailscaleIPv4("100.64.0.0")).toBe(true);
      expect(isTailscaleIPv4("100.64.0.1")).toBe(true);
      expect(isTailscaleIPv4("100.100.50.25")).toBe(true);
      expect(isTailscaleIPv4("100.127.255.255")).toBe(true);
    });

    test("rejects outside 100.64/10 boundaries", () => {
      expect(isTailscaleIPv4("100.63.255.255")).toBe(false);
      expect(isTailscaleIPv4("100.128.0.0")).toBe(false);
      expect(isTailscaleIPv4("100.0.0.1")).toBe(false);
      expect(isTailscaleIPv4("100.255.255.255")).toBe(false);
      expect(isTailscaleIPv4("10.64.0.1")).toBe(false);
    });

    test("accepts IPv4-mapped IPv6 Tailscale addresses", () => {
      expect(isTailscaleIPv4("::ffff:100.64.0.1")).toBe(true);
      expect(isTailscaleIPv4("::ffff:100.65.79.98")).toBe(true);
      expect(isTailscaleIPv4("::ffff:100.127.255.255")).toBe(true);
      expect(isTailscaleIPv4("::ffff:100.63.255.255")).toBe(false);
      expect(isTailscaleIPv4("::ffff:100.128.0.1")).toBe(false);
    });
  });

  describe("Tailscale fd7a:115c:a1e0::/48 IPv6", () => {
    test("accepts fd7a:115c:a1e0::/48", () => {
      expect(isTailscaleIPv6("fd7a:115c:a1e0::1")).toBe(true);
      expect(isTailscaleIPv6("fd7a:115c:a1e0:0:0:0:0:1")).toBe(true);
      expect(isTailscaleIPv6("fd7a:115c:a1e0:abcd:1234:5678:9abc:def0")).toBe(true);
    });

    test("rejects outside fd7a:115c:a1e0::/48", () => {
      expect(isTailscaleIPv6("fd7a:115c:a1e1::1")).toBe(false);
      expect(isTailscaleIPv6("fd7a:115c:a1df::1")).toBe(false);
      expect(isTailscaleIPv6("fd7b:115c:a1e0::1")).toBe(false);
      expect(isTailscaleIPv6("fe80::1")).toBe(false);
      expect(isTailscaleIPv6("::1")).toBe(false);
    });
  });

  describe("isAllowedRemoteAddress per access mode", () => {
    test("local mode: loopback only", () => {
      expect(isAllowedRemoteAddress("127.0.0.1", "local")).toBe(true);
      expect(isAllowedRemoteAddress("::1", "local")).toBe(true);
      expect(isAllowedRemoteAddress("::ffff:127.0.0.1", "local")).toBe(true);
      expect(isAllowedRemoteAddress("100.65.79.98", "local")).toBe(false);
      expect(isAllowedRemoteAddress("fd7a:115c:a1e0::1", "local")).toBe(false);
      expect(isAllowedRemoteAddress("192.168.1.10", "local")).toBe(false);
      expect(isAllowedRemoteAddress("10.0.0.1", "local")).toBe(false);
      expect(isAllowedRemoteAddress(undefined, "local")).toBe(false);
    });

    test("tailscale mode: loopback and Tailscale peers", () => {
      // Loopback
      expect(isAllowedRemoteAddress("127.0.0.1", "tailscale")).toBe(true);
      expect(isAllowedRemoteAddress("::1", "tailscale")).toBe(true);
      expect(isAllowedRemoteAddress("::ffff:127.0.0.1", "tailscale")).toBe(true);

      // Tailscale peers
      expect(isAllowedRemoteAddress("100.64.0.1", "tailscale")).toBe(true);
      expect(isAllowedRemoteAddress("100.65.79.98", "tailscale")).toBe(true);
      expect(isAllowedRemoteAddress("::ffff:100.65.79.98", "tailscale")).toBe(true);
      expect(isAllowedRemoteAddress("fd7a:115c:a1e0::1", "tailscale")).toBe(true);

      // Outside Tailscale / LAN / public rejected
      expect(isAllowedRemoteAddress("100.63.255.255", "tailscale")).toBe(false);
      expect(isAllowedRemoteAddress("100.128.0.1", "tailscale")).toBe(false);
      expect(isAllowedRemoteAddress("192.168.1.10", "tailscale")).toBe(false);
      expect(isAllowedRemoteAddress("10.0.0.1", "tailscale")).toBe(false);
      expect(isAllowedRemoteAddress("8.8.8.8", "tailscale")).toBe(false);
      expect(isAllowedRemoteAddress(undefined, "tailscale")).toBe(false);
    });

    test("network mode: accepts any remote address", () => {
      expect(isAllowedRemoteAddress("127.0.0.1", "network")).toBe(true);
      expect(isAllowedRemoteAddress("::1", "network")).toBe(true);
      expect(isAllowedRemoteAddress("100.65.79.98", "network")).toBe(true);
      expect(isAllowedRemoteAddress("192.168.1.10", "network")).toBe(true);
      expect(isAllowedRemoteAddress("10.0.0.1", "network")).toBe(true);
      expect(isAllowedRemoteAddress("8.8.8.8", "network")).toBe(true);
      expect(isAllowedRemoteAddress(undefined, "network")).toBe(false);
    });
  });

  describe("urlLabel", () => {
    test("classifies correctly", () => {
      expect(urlLabel("http://127.0.0.1:4848/#tok")).toBe("this machine");
      expect(urlLabel("http://localhost:4848/#tok")).toBe("this machine");
      expect(urlLabel("http://[::1]:4848/#tok")).toBe("this machine");
      expect(urlLabel("http://100.65.79.98:4848/#tok")).toBe("Tailscale");
      expect(urlLabel("http://device.tailscale.ts.net:4848/#tok")).toBe("Tailscale");
      expect(urlLabel("http://192.168.1.50:4848/#tok")).toBe("network");
    });
  });

  describe("resolveBoardUrls", () => {
    test("local mode publishes loopback URL only", async () => {
      const urls = await resolveBoardUrls({ port: 4848, token: "tok123", access: "local" });
      expect(urls).toEqual(["http://127.0.0.1:4848/#tok123"]);
    });

    test("tailscale mode queries tailscale status via Run", async () => {
      const fakeRun: Run = async (cmd, args) => {
        if (cmd === "tailscale" && args[0] === "status") {
          return {
            stdout: JSON.stringify({
              Self: {
                DNSName: "myhost.tail1234.ts.net.",
                TailscaleIPs: ["100.65.79.98", "fd7a:115c:a1e0::98"],
              },
            }),
            stderr: "",
            code: 0,
          };
        }
        return { stdout: "", stderr: "", code: 1 };
      };

      const urls = await resolveBoardUrls({ port: 4848, token: "tok123", access: "tailscale", run: fakeRun });
      expect(urls).toContain("http://127.0.0.1:4848/#tok123");
      expect(urls).toContain("http://myhost.tail1234.ts.net:4848/#tok123");
      expect(urls).toContain("http://100.65.79.98:4848/#tok123");
    });
  });
});
