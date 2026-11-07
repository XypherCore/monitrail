import { describe, expect, it } from "vitest";
import { displayMonitorUrl } from "./display-url.ts";

describe("dashboard monitor URL", () => {
  it("replaces the entire query string without exposing names or values", () => {
    expect(displayMonitorUrl("https://example.test/health?key=sensitive-value&other=%3F")).toBe(
      "https://example.test/health?…",
    );
  });

  it("drops credentials and fragments, preserving the scheme, host, port and path", () => {
    expect(displayMonitorUrl("http://user:secret@example.test:8080/health#secret")).toBe(
      "http://example.test:8080/health",
    );
  });

  it.each(["not a URL?secret=value", "data:text/plain,secret?key=value"])(
    "fails closed for legacy values that are not HTTP URLs",
    (url) => {
      expect(displayMonitorUrl(url)).toBe("URL unavailable");
    },
  );
});
