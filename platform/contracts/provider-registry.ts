import { z } from "zod";

export const LaunchableKindSchema = z.literal("codex").nullable();

export const PROVIDER_REGISTRY = {
  openai: {
    provider: "openai",
    label: "OpenAI API key",
    credential: {
      envVar: "OPENAI_API_KEY",
      aliases: ["OPENAI_API_KEY", "openai_api_key", "api_key"],
      launchableKind: "codex",
    },
    modelCatalog: true,
    execution: true,
    manager: true,
  },
  anthropic: {
    provider: "anthropic",
    label: "Anthropic API key",
    credential: {
      envVar: "ANTHROPIC_API_KEY",
      aliases: ["ANTHROPIC_API_KEY", "anthropic_api_key"],
      launchableKind: null,
    },
    modelCatalog: true,
    execution: true,
  },
  xai: {
    provider: "xai",
    label: "xAI API key",
    credential: {
      envVar: "XAI_API_KEY",
      aliases: ["XAI_API_KEY", "xai_api_key"],
      launchableKind: null,
    },
    modelCatalog: true,
  },
  google: {
    provider: "google",
    label: "Google Gemini API key",
    credential: {
      envVar: "GEMINI_API_KEY",
      aliases: [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "gemini_api_key",
        "google_api_key",
      ],
      launchableKind: null,
    },
    modelCatalog: true,
  },
  mistral: {
    provider: "mistral",
    label: "Mistral API key",
    credential: {
      envVar: "MISTRAL_API_KEY",
      aliases: ["MISTRAL_API_KEY", "mistral_api_key"],
      launchableKind: null,
    },
    modelCatalog: true,
  },
  groq: {
    provider: "groq",
    label: "Groq API key",
    credential: {
      envVar: "GROQ_API_KEY",
      aliases: ["GROQ_API_KEY", "groq_api_key"],
      launchableKind: null,
    },
    modelCatalog: true,
  },
  openrouter: {
    provider: "openrouter",
    label: "OpenRouter API key",
    credential: {
      envVar: "OPENROUTER_API_KEY",
      aliases: ["OPENROUTER_API_KEY", "openrouter_api_key"],
      launchableKind: null,
    },
    modelCatalog: true,
  },
  together: {
    provider: "together",
    label: "Together AI API key",
    credential: {
      envVar: "TOGETHER_API_KEY",
      aliases: ["TOGETHER_API_KEY", "together_api_key"],
      launchableKind: null,
    },
    modelCatalog: true,
  },
  perplexity: {
    provider: "perplexity",
    label: "Perplexity API key",
    credential: {
      envVar: "PERPLEXITY_API_KEY",
      aliases: ["PERPLEXITY_API_KEY", "perplexity_api_key"],
      launchableKind: null,
    },
    modelCatalog: true,
  },
  azure: {
    provider: "azure",
    label: "Azure OpenAI API key",
    credential: {
      envVar: "AZURE_OPENAI_API_KEY",
      aliases: ["AZURE_OPENAI_API_KEY", "azure_openai_api_key"],
      launchableKind: null,
    },
    modelCatalog: true,
  },
  openai_codex: {
    provider: "openai_codex",
    label: "ChatGPT (OAuth)",
    credential: {
      envVar: "OPENAI_API_KEY",
      aliases: ["access_token"],
      launchableKind: "codex",
    },
    modelCatalog: true,
    execution: true,
  },
  linear: {
    provider: "linear",
    label: "Linear API key",
    credential: {
      envVar: "LINEAR_API_KEY",
      aliases: ["LINEAR_API_KEY", "linear_api_key", "api_key"],
      launchableKind: null,
    },
    modelCatalog: false,
    execution: false,
    manager: false,
  },
  github: {
    provider: "github",
    label: "GitHub personal access token",
    credential: {
      envVar: "GITHUB_TOKEN",
      aliases: ["GITHUB_TOKEN", "GH_TOKEN", "github_token", "api_key"],
      launchableKind: null,
    },
    modelCatalog: false,
    execution: false,
    manager: false,
  },
  codex: {
    provider: "codex",
    label: "Codex",
    execution: true,
  },
  openai_compatible: {
    provider: "openai_compatible",
    label: "OpenAI-compatible",
    execution: true,
    manager: true,
  },
  openclaw: {
    provider: "openclaw",
    label: "OpenClaw",
    execution: true,
  },
  local: {
    provider: "local",
    label: "Local relay",
    execution: true,
  },
  computer_use: {
    provider: "computer_use",
    label: "Computer use",
    execution: true,
  },
  bedrock: {
    provider: "bedrock",
    label: "Amazon Bedrock",
    modelCatalog: true,
  },
} as const;

export const CREDENTIAL_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "xai",
  "google",
  "mistral",
  "groq",
  "openrouter",
  "together",
  "perplexity",
  "azure",
  "openai_codex",
  "linear",
  "github",
] as const;

export const KNOWN_EXECUTION_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "codex",
  "openai_compatible",
  "openai_codex",
  "openclaw",
  "computer_use",
  "local",
] as const;

export const MANAGER_PROVIDER_IDS = ["openai", "openai_compatible"] as const;

/**
 * Runtime-family providers — these identify *what runs locally* on the
 * other side of a relay-transport routing rule (runner_kind=local_relay).
 * They mirror the runtime-family branch of the routing_rule.provider DB
 * check constraint (migration 20260513150000).
 */
export const RUNTIME_FAMILY_PROVIDER_IDS = [
  "openclaw",
  "codex",
  "computer_use",
  "local",
] as const;
export type RuntimeFamilyProvider =
  (typeof RUNTIME_FAMILY_PROVIDER_IDS)[number];

export const MODEL_PROVIDER_IDS = [
  "openai",
  "openai_codex",
  "anthropic",
  "xai",
  "google",
  "mistral",
  "groq",
  "openrouter",
  "together",
  "perplexity",
  "bedrock",
  "azure",
] as const;

export const CredentialProviderSchema = z.enum(CREDENTIAL_PROVIDER_IDS);
export const KnownExecutionProviderSchema = z.enum(
  KNOWN_EXECUTION_PROVIDER_IDS,
);
export const ManagerProviderSchema = z.enum(MANAGER_PROVIDER_IDS);
export const ModelProviderSchema = z.enum(MODEL_PROVIDER_IDS);

export type LaunchableKind = z.infer<typeof LaunchableKindSchema>;
export type CredentialProvider = z.infer<typeof CredentialProviderSchema>;
export type KnownExecutionProvider = z.infer<
  typeof KnownExecutionProviderSchema
>;
export type ManagerProvider = z.infer<typeof ManagerProviderSchema>;
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const CREDENTIAL_PROVIDER_REGISTRY = {
  openai: {
    provider: "openai",
    envVar: PROVIDER_REGISTRY.openai.credential.envVar,
    aliases: PROVIDER_REGISTRY.openai.credential.aliases,
    label: PROVIDER_REGISTRY.openai.label,
    launchableKind: PROVIDER_REGISTRY.openai.credential.launchableKind,
  },
  anthropic: {
    provider: "anthropic",
    envVar: PROVIDER_REGISTRY.anthropic.credential.envVar,
    aliases: PROVIDER_REGISTRY.anthropic.credential.aliases,
    label: PROVIDER_REGISTRY.anthropic.label,
    launchableKind: PROVIDER_REGISTRY.anthropic.credential.launchableKind,
  },
  xai: {
    provider: "xai",
    envVar: PROVIDER_REGISTRY.xai.credential.envVar,
    aliases: PROVIDER_REGISTRY.xai.credential.aliases,
    label: PROVIDER_REGISTRY.xai.label,
    launchableKind: PROVIDER_REGISTRY.xai.credential.launchableKind,
  },
  google: {
    provider: "google",
    envVar: PROVIDER_REGISTRY.google.credential.envVar,
    aliases: PROVIDER_REGISTRY.google.credential.aliases,
    label: PROVIDER_REGISTRY.google.label,
    launchableKind: PROVIDER_REGISTRY.google.credential.launchableKind,
  },
  mistral: {
    provider: "mistral",
    envVar: PROVIDER_REGISTRY.mistral.credential.envVar,
    aliases: PROVIDER_REGISTRY.mistral.credential.aliases,
    label: PROVIDER_REGISTRY.mistral.label,
    launchableKind: PROVIDER_REGISTRY.mistral.credential.launchableKind,
  },
  groq: {
    provider: "groq",
    envVar: PROVIDER_REGISTRY.groq.credential.envVar,
    aliases: PROVIDER_REGISTRY.groq.credential.aliases,
    label: PROVIDER_REGISTRY.groq.label,
    launchableKind: PROVIDER_REGISTRY.groq.credential.launchableKind,
  },
  openrouter: {
    provider: "openrouter",
    envVar: PROVIDER_REGISTRY.openrouter.credential.envVar,
    aliases: PROVIDER_REGISTRY.openrouter.credential.aliases,
    label: PROVIDER_REGISTRY.openrouter.label,
    launchableKind: PROVIDER_REGISTRY.openrouter.credential.launchableKind,
  },
  together: {
    provider: "together",
    envVar: PROVIDER_REGISTRY.together.credential.envVar,
    aliases: PROVIDER_REGISTRY.together.credential.aliases,
    label: PROVIDER_REGISTRY.together.label,
    launchableKind: PROVIDER_REGISTRY.together.credential.launchableKind,
  },
  perplexity: {
    provider: "perplexity",
    envVar: PROVIDER_REGISTRY.perplexity.credential.envVar,
    aliases: PROVIDER_REGISTRY.perplexity.credential.aliases,
    label: PROVIDER_REGISTRY.perplexity.label,
    launchableKind: PROVIDER_REGISTRY.perplexity.credential.launchableKind,
  },
  azure: {
    provider: "azure",
    envVar: PROVIDER_REGISTRY.azure.credential.envVar,
    aliases: PROVIDER_REGISTRY.azure.credential.aliases,
    label: PROVIDER_REGISTRY.azure.label,
    launchableKind: PROVIDER_REGISTRY.azure.credential.launchableKind,
  },
  openai_codex: {
    provider: "openai_codex",
    envVar: PROVIDER_REGISTRY.openai_codex.credential.envVar,
    aliases: PROVIDER_REGISTRY.openai_codex.credential.aliases,
    label: PROVIDER_REGISTRY.openai_codex.label,
    launchableKind: PROVIDER_REGISTRY.openai_codex.credential.launchableKind,
  },
  linear: {
    provider: "linear",
    envVar: PROVIDER_REGISTRY.linear.credential.envVar,
    aliases: PROVIDER_REGISTRY.linear.credential.aliases,
    label: PROVIDER_REGISTRY.linear.label,
    launchableKind: PROVIDER_REGISTRY.linear.credential.launchableKind,
  },
  github: {
    provider: "github",
    envVar: PROVIDER_REGISTRY.github.credential.envVar,
    aliases: PROVIDER_REGISTRY.github.credential.aliases,
    label: PROVIDER_REGISTRY.github.label,
    launchableKind: PROVIDER_REGISTRY.github.credential.launchableKind,
  },
} as const satisfies Record<
  CredentialProvider,
  {
    provider: CredentialProvider;
    envVar: string;
    aliases: readonly string[];
    label: string;
    launchableKind: LaunchableKind;
  }
>;

export const CREDENTIAL_PROVIDERS = Object.values(CREDENTIAL_PROVIDER_REGISTRY);
