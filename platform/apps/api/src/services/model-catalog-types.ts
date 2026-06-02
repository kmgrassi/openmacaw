import type {
  ModelAuthMode,
  ModelCatalogEntry,
  ModelCatalogError,
  ModelProvider,
} from "../../../../contracts/model-catalog.js";

export type ProviderCredential = {
  value: string;
  sourceKey: string;
  endpoint?: string | null;
  apiVersion?: string | null;
};

export type ProviderAdapter = {
  provider: ModelProvider;
  providerName: string;
  description: string;
  envVars: string[];
  authModes: [ModelAuthMode, ...ModelAuthMode[]];
  requiresEndpoint?: boolean;
  fetchModels: (credential: ProviderCredential) => Promise<ModelCatalogEntry[]>;
};

export type ProviderCatalogResult = {
  models: ModelCatalogEntry[];
  errors: ModelCatalogError[];
};

export type CredentialLookupResult = {
  credentials: Map<ModelProvider, ProviderCredential>;
  errors: ModelCatalogError[];
};
