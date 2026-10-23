import { describe, expect, it } from "vitest";
import { formatHttpAddress } from "../lib/http-address.js";

describe("HTTP address formatting", () => {
  it.each([
    ["::1", "[::1]:3333"],
    ["2001:db8::42", "[2001:db8::42]:3333"],
    ["::ffff:192.0.2.1", "[::ffff:192.0.2.1]:3333"],
    ["127.0.0.1", "127.0.0.1:3333"],
    ["vault.example.com", "vault.example.com:3333"],
  ])("formats %s with its port", (host, expected) => {
    expect(formatHttpAddress(host, 3333)).toBe(expected);
  });
});
