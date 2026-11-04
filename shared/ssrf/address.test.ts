import { describe, expect, it } from "vitest";
import { canonicalHostname, isPublicAddress, parseTarget } from "./address.ts";

describe("target address eligibility", () => {
  it.each([
    "1.1.1.1", "8.8.8.8", "9.9.9.9", "93.184.216.34",
    "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0",
    "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0",
    "192.0.1.255", "192.0.3.0", "192.167.255.255", "192.169.0.0",
    "198.17.255.255", "198.20.0.0", "203.0.114.0", "223.255.255.255",
    "168.63.129.15", "168.63.129.17",
  ])("permits ordinary IPv4 unicast and adjacent public boundaries: %s", address => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    "0.0.0.0", "0.255.255.255", "10.0.0.0", "10.255.255.255",
    "100.64.0.0", "100.127.255.255", "127.0.0.0", "127.255.255.255",
    "169.254.0.0", "169.254.255.255", "172.16.0.0", "172.31.255.255",
    "192.0.0.0", "192.0.0.255", "192.0.0.9", "192.0.2.0", "192.0.2.255",
    "192.31.196.0", "192.31.196.255", "192.52.193.0", "192.52.193.255",
    "192.88.99.0", "192.88.99.255", "192.168.0.0", "192.168.255.255",
    "192.175.48.0", "192.175.48.255", "198.18.0.0", "198.19.255.255",
    "198.51.100.0", "198.51.100.255", "203.0.113.0", "203.0.113.255",
    "224.0.0.0", "239.255.255.255", "240.0.0.0", "255.255.255.255",
    "169.254.169.254", "169.254.170.2", "100.100.100.200", "168.63.129.16",
  ])("rejects private, shared, special-purpose, metadata and multicast IPv4: %s", address => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450::1",
    "2001:200::1", "2001:3ff:ffff:ffff:ffff:ffff:ffff:ffff", "2001:400::1",
    "2001:4c00::1", "2001:bfff:ffff:ffff:ffff:ffff:ffff:ffff",
    "2003::1", "2003:3fff:ffff:ffff:ffff:ffff:ffff:ffff", "2410::1",
    "2610::1", "2630::1", "2a10::1", "2c00::1",
    "::ffff:8.8.8.8", "::ffff:808:808", "[::ffff:808:808]",
  ])("permits allocated public IPv6 or mapped public IPv4: %s", address => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    "::", "::1", "::2", "::127.0.0.1", "::8.8.8.8", "::ffff:127.0.0.1",
    "::ffff:7f00:1", "::ffff:a00:1", "::ffff:a9fe:a9fe", "::ffff:0:7f00:1",
    "64:ff9b::808:808", "64:ff9b::a00:1", "64:ff9b:1::1", "100::1",
    "100:0:0:1::1", "2001::1", "2001:1::1", "2001:20::1", "2001:db8::1",
    "2002:0808:0808::1", "2620:4f:8000::1", "3fff::1", "3ffe::1",
    "2001:1000::1", "2001:c000::1", "2003:4000::1", "2420::1", "2640::1",
    "2b00::1", "2d00::1", "4000::1", "5f00::1", "fc00::1", "fd00:ec2::254",
    "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe80::1", "fec0::1", "ff00::1",
  ])("rejects unsafe transitions, unallocated/special IPv6 and mapped private IPv4: %s", address => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "", "example.com", "8..8.8", "256.1.1.1", "8.8.8.8:80", "[::1]:80",
    "[::ffff:8.8.8.8", "::ffff:8.8.8.999", "2001:::1", "2001:4860::1::2",
    "2001:4860:0:0:0:0:0:0:1", "fe80::1%eth0", "2001:4860::1%25eth0",
    " 8.8.8.8", "8.8.8.8\n", "8.8.8.8/", "8.8.8.8?x", "user@8.8.8.8",
  ])("fails closed for malformed literal addresses: %s", address => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe("hostname canonicalization", () => {
  it.each([
    ["EXAMPLE.COM.", "example.com"], ["bücher.example", "xn--bcher-kva.example"],
    ["127.1", "127.0.0.1"], ["0x08080808", "8.8.8.8"],
    ["2001:4860:0:0:0:0:0:8888", "[2001:4860::8888]"],
    ["[::FFFF:8.8.8.8]", "[::ffff:808:808]"],
  ])("normalizes hostname-only input consistently: %s", (input, expected) => {
    expect(canonicalHostname(input)).toBe(expected);
  });
  it.each([
    "localhost", "LOCALHOST.", "site.localhost", "site.local", "site.internal",
    "local", "internal", "single-label", "example.com..", "example..com",
    "example.com:443", "user@example.com", "example.com/path", "example.com?x",
    "example.com#x", "example.com\\path", "-example.com", "example-.com",
    `${"x".repeat(64)}.com`, `${"x".repeat(63)}.${"x".repeat(63)}.${"x".repeat(63)}.${"x".repeat(63)}.com`,
  ])("rejects forbidden or ambiguous hostname syntax: %s", input => {
    expect(canonicalHostname(input)).toBeNull();
  });
});

describe("target URL parsing before any I/O", () => {
  it.each([
    ["HTTPS://EXAMPLE.COM.:443/a?token=private#not-sent", "https://example.com/a?token=private"],
    ["http://example.com:8080/", "http://example.com:8080/"],
    ["https://example.com:8443/", "https://example.com:8443/"],
    ["https://example.com:80/", "https://example.com:80/"],
    ["http://example.com:443/", "http://example.com:443/"],
    ["http://134744072/", "http://8.8.8.8/"],
    ["http://010.010.010.010/", "http://8.8.8.8/"],
    ["http://0x08080808/", "http://8.8.8.8/"],
    ["https://bücher.example/", "https://xn--bcher-kva.example/"],
    ["https://[::ffff:8.8.8.8]/", "https://[::ffff:808:808]/"],
  ])("canonicalizes allowed targets without dropping path/query: %s", (input, expected) => {
    expect(parseTarget(input).href).toBe(expected);
  });

  it.each([
    "file:///etc/passwd", "ftp://example.com", "data:text/plain,hello", "javascript:alert(1)",
    "https:example.com", "//example.com", "https:///example.com", "http:////example.com",
    "http://user:secret@example.com", "http://@example.com", "http://:@example.com",
    "http://user@@example.com", "http://%75ser@example.com", "http://example.com\\@127.0.0.1",
    "http://localhost", "http://localhost.", "http://x.LOCALHOST.", "http://a.local",
    "http://a.internal", "http://single-label", "http://example..com", "http://example.com..",
    "http://example.com:0", "http://example.com:22", "http://example.com:8000", "http://example.com:65536",
    "http://127.1", "http://2130706433", "http://0177.0.0.1", "http://0x7f000001",
    "http://0x7f.0.0.1", "http://169.254.169.254", "http://168.63.129.16",
    "http://[::ffff:127.0.0.1]", "http://[::ffff:7f00:1]", "http://[64:ff9b::a00:1]",
    "http://[2001:db8::1]", "http://[2002:0808:0808::1]", "http://[fe80::1%25eth0]",
    " http://example.com", "http://example.com\n", "http://exam\tple.com", "http://example.com/a b",
    "http://\u0000example.com", "", "not a URL",
  ])("rejects unsafe targets with a fixed non-sensitive error: %s", input => {
    expect(() => parseTarget(input)).toThrowError(new Error("Target URL is not allowed."));
  });
  it("does not mistake @ in path/query for authority userinfo", () => {
    expect(parseTarget("https://example.com/path@name?contact=a@b").href).toBe("https://example.com/path@name?contact=a@b");
  });
});
