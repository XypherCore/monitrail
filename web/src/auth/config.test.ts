import { describe, expect, it } from "vitest";
import { readAuthConfig } from "./config.ts";

const fixture = {
  APP_URL: "http://localhost:3000",
  AUTH_SECRET: "fixture-auth-secret-with-at-least-32-characters",
  AUTH_GITHUB_ID: "fixture-github-id",
  AUTH_GITHUB_SECRET: "fixture-github-secret",
  AUTH_GOOGLE_ID: "fixture-google-id",
  AUTH_GOOGLE_SECRET: "fixture-google-secret",
};

describe("authentication configuration", () => {
  it("maps the project's existing environment names explicitly", () => {
    expect(readAuthConfig(fixture).baseURL).toBe("http://localhost:3000");
    expect(readAuthConfig({ ...fixture, APP_URL: "https://app.example.invalid/" }, true).baseURL).toBe("https://app.example.invalid");
  });
  it.each(["https://app.example.invalid/path", "https://user:pass@app.example.invalid", "https://app.example.invalid?query", "https://app.example.invalid/#hash", "http://public.example.invalid", "ftp://localhost:3000", "not-a-url"])("refuses unsafe origins without exposing their values", APP_URL => {
    expect(() => readAuthConfig({ ...fixture, APP_URL })).toThrow("Authentication configuration is invalid.");
  });
  it("requires HTTPS outside explicitly local development", () => {
    expect(() => readAuthConfig(fixture, true)).toThrow("Authentication configuration is invalid.");
  });
  it.each(Object.keys(fixture))("requires %s and never reports its value", key => {
    expect(() => readAuthConfig({ ...fixture, [key]: "" })).toThrow("Authentication configuration is invalid.");
  });
  it("rejects short secrets and placeholder values", () => {
    expect(() => readAuthConfig({ ...fixture, AUTH_SECRET: "short" })).toThrow();
    expect(() => readAuthConfig({ ...fixture, AUTH_GITHUB_SECRET: "<GitHub client secret>" })).toThrow();
  });
});
