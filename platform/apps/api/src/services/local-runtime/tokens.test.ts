import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateMachineToken } from "./tokens.js";

describe("generateMachineToken", () => {
  let priorDevToken: string | undefined;
  let priorNodeEnv: string | undefined;

  beforeEach(() => {
    priorDevToken = process.env.LOCAL_RELAY_DEV_TOKEN;
    priorNodeEnv = process.env.NODE_ENV;
    delete process.env.LOCAL_RELAY_DEV_TOKEN;
  });

  afterEach(() => {
    if (priorDevToken === undefined) delete process.env.LOCAL_RELAY_DEV_TOKEN;
    else process.env.LOCAL_RELAY_DEV_TOKEN = priorDevToken;
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
  });

  it("generates a random lrh_-prefixed token by default", () => {
    const a = generateMachineToken();
    const b = generateMachineToken();
    expect(a).toMatch(/^lrh_[A-Za-z0-9_-]+$/);
    expect(a).not.toEqual(b);
  });

  it("returns the fixed dev token when LOCAL_RELAY_DEV_TOKEN is set outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.LOCAL_RELAY_DEV_TOKEN = "lrh_dev_local_token_2026";
    expect(generateMachineToken()).toBe("lrh_dev_local_token_2026");
  });

  it("ignores the dev token override in production", () => {
    process.env.NODE_ENV = "production";
    process.env.LOCAL_RELAY_DEV_TOKEN = "lrh_dev_local_token_2026";
    expect(generateMachineToken()).not.toBe("lrh_dev_local_token_2026");
    expect(generateMachineToken()).toMatch(/^lrh_[A-Za-z0-9_-]+$/);
  });

  it("ignores a blank dev token override", () => {
    process.env.NODE_ENV = "development";
    process.env.LOCAL_RELAY_DEV_TOKEN = "   ";
    expect(generateMachineToken()).toMatch(/^lrh_[A-Za-z0-9_-]+$/);
  });
});
