import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_PROVIDER_REGISTRY,
  credentialRecordMatchesProvider,
  detectCredentialProviderFromRecord,
  detectInlineCredentialSecret,
  getCredentialProviderMetadata,
  maskCredentialLabel,
  normalizeCredentialProvider,
} from "../../../contracts/credentials.js";
import { CREDENTIAL_PROVIDER_IDS, PROVIDER_REGISTRY } from "../../../contracts/provider-registry.js";

describe("credential provider metadata", () => {
  it("normalizes supported provider names", () => {
    expect(normalizeCredentialProvider(" OpenAI ")).toBe("openai");
    expect(normalizeCredentialProvider("ANTHROPIC")).toBe("anthropic");
    expect(normalizeCredentialProvider("linear")).toBe("linear");
    expect(normalizeCredentialProvider("GITHUB")).toBe("github");
    expect(normalizeCredentialProvider(null)).toBeNull();
  });

  it("registers tracker credential providers outside model execution flows", () => {
    expect(CREDENTIAL_PROVIDER_IDS).toEqual(expect.arrayContaining(["linear", "github"]));
    expect(CREDENTIAL_PROVIDER_REGISTRY.linear).toMatchObject({
      envVar: "LINEAR_API_KEY",
      label: "Linear API key",
      launchableKind: null,
    });
    expect(CREDENTIAL_PROVIDER_REGISTRY.github).toMatchObject({
      envVar: "GITHUB_TOKEN",
      label: "GitHub personal access token",
      launchableKind: null,
    });
    expect(PROVIDER_REGISTRY.linear).toMatchObject({
      modelCatalog: false,
      execution: false,
      manager: false,
    });
    expect(PROVIDER_REGISTRY.github).toMatchObject({
      modelCatalog: false,
      execution: false,
      manager: false,
    });
  });

  it("detects providers from explicit provider fields and registered aliases", () => {
    expect(detectCredentialProviderFromRecord({ provider: "OpenAI" })).toBe("openai");
    expect(detectCredentialProviderFromRecord({ openai_api_key: "sk-test" })).toBe("openai");
    expect(detectCredentialProviderFromRecord({ ANTHROPIC_API_KEY: "sk-ant-test" })).toBe("anthropic");
    expect(detectCredentialProviderFromRecord({ LINEAR_API_KEY: "lin-test" })).toBe("linear");
    expect(detectCredentialProviderFromRecord({ GITHUB_TOKEN: "ghp-test" })).toBe("github");
    expect(detectCredentialProviderFromRecord({ api_key: "sk-test" })).toBe("openai");
    expect(detectCredentialProviderFromRecord({ provider: "custom", OPENAI_API_KEY: "sk-test" })).toBe("custom");
  });

  it("finds inline secrets from registered aliases", () => {
    expect(detectInlineCredentialSecret({ openai_api_key: "  sk-test  " }, CREDENTIAL_PROVIDER_REGISTRY.openai)).toBe(
      "sk-test",
    );
    expect(detectInlineCredentialSecret({ anthropic_api_key: "" }, CREDENTIAL_PROVIDER_REGISTRY.anthropic)).toBeNull();
  });

  it("matches credential records with aliases, explicit providers, and codex secret refs", () => {
    expect(credentialRecordMatchesProvider({ OPENAI_API_KEY: "sk-test" }, "openai")).toBe(true);
    expect(credentialRecordMatchesProvider({ provider: "anthropic" }, "anthropic")).toBe(true);
    expect(credentialRecordMatchesProvider({ secret_ref: "aws:secret" }, "openai")).toBe(true);
    expect(credentialRecordMatchesProvider({ secret_ref: "aws:secret" }, "anthropic")).toBe(false);
  });

  it("exposes env vars, labels, launchability, and masked labels from one registry", () => {
    expect(getCredentialProviderMetadata("openai")).toMatchObject({
      envVar: "OPENAI_API_KEY",
      label: "OpenAI API key",
      launchableKind: "codex",
    });
    expect(getCredentialProviderMetadata("anthropic")).toMatchObject({
      envVar: "ANTHROPIC_API_KEY",
      label: "Anthropic API key",
      launchableKind: null,
    });
    expect(getCredentialProviderMetadata("linear")).toMatchObject({
      envVar: "LINEAR_API_KEY",
      label: "Linear API key",
      launchableKind: null,
    });
    expect(maskCredentialLabel(CREDENTIAL_PROVIDER_REGISTRY.openai, "1234")).toBe("OpenAI API key ••••1234");
    expect(maskCredentialLabel(CREDENTIAL_PROVIDER_REGISTRY.anthropic, null)).toBe("Anthropic API key");
  });
});
