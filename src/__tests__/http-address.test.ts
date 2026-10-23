import { describe, expect, it } from "vitest";
import { formatHttpAddress } from "../lib/http-address.js";

describe("HTTP address formatting", () => {
  it.each([
    ["::1", "[::1]:3333"],
    ["2001:db8::42", "[2001:db8::42]:3333"],
    ["::ffff:192.0.2.1", "[::ffff:c000:201]:3333"],
    ["2001:0DB8:0000:0000:0000:0000:0000:0042", "[2001:db8::42]:3333"],
    ["0:0:0:0:0:ffff:7f00:0001", "[::ffff:7f00:1]:3333"],
    ["127.0.0.1", "127.0.0.1:3333"],
    ["vault.example.com", "vault.example.com:3333"],
  ])("formats %s with its port", (host, expected) => {
    expect(formatHttpAddress(host, 3333)).toBe(expected);
  });
  it("rejects scoped IPv6 because it has no supported HTTP URL spelling", () => {
    expect(() => formatHttpAddress("fe80::1%eth0", 3333)).toThrow(
      "Scoped IPv6 bind addresses are not supported for HTTP URLs"
    );
  });
});
