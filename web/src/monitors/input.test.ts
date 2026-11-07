import { describe, expect, it } from "vitest";
import { MonitorInputError, parseMonitorFields, parseMonitorUpdate } from "./input.ts";

const fields = {
  name: "Example",
  url: "https://example.invalid/",
  intervalSeconds: 300,
  expectedStatus: "2xx",
};

describe("monitor settings", () => {
  it("applies the documented defaults when creating a monitor", () => {
    expect(parseMonitorFields({ name: "  Example  ", url: fields.url }, "create")).toEqual(fields);
  });

  it.each([300, 600, 900, 1800, 3600])("accepts an interval of %s seconds", (intervalSeconds) => {
    expect(parseMonitorFields({ ...fields, intervalSeconds, expectedStatus: "2xx_3xx" }, "create"))
      .toMatchObject({ intervalSeconds, expectedStatus: "2xx_3xx" });
  });

  it.each([299, 301, 1200, 86400, "300", null])("rejects unsupported interval %s", (intervalSeconds) => {
    expect(() => parseMonitorFields({ ...fields, intervalSeconds }, "create"))
      .toThrow(expect.objectContaining({ field: "intervalSeconds" }));
  });

  it.each(["200", "3xx", "2xx_or_3xx", null])("rejects unsupported expected status %s", (expectedStatus) => {
    expect(() => parseMonitorFields({ ...fields, expectedStatus }, "edit"))
      .toThrow(expect.objectContaining({ field: "expectedStatus" }));
  });

  it("permits edits that preserve the stored URL without accepting an empty replacement", () => {
    const { url: _url, ...edit } = fields;
    expect(parseMonitorUpdate(edit)).toEqual({ kind: "edit", fields: edit });
    expect(() => parseMonitorFields({ ...edit, url: "" }, "edit"))
      .toThrow(expect.objectContaining({ field: "url" }));
  });

  it("rejects attempts to supply ownership and state fields", () => {
    expect(() => parseMonitorFields({ ...fields, userId: "other" }, "create")).toThrow(MonitorInputError);
    expect(() => parseMonitorUpdate({ ...fields, isPaused: false })).toThrow(MonitorInputError);
    expect(parseMonitorUpdate({ isPaused: false })).toEqual({ kind: "pause", isPaused: false });
  });
});
