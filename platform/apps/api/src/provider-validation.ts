import { type CredentialValidationResult } from "../../../contracts/credentials.js";

function normalizeOpenAiModel(model: string | null): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const slashIndex = trimmed.indexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

export async function validateOpenAiCredential(
  apiKey: string,
  model: string | null,
): Promise<CredentialValidationResult> {
  const checkedAt = new Date().toISOString();
  const normalizedModel = normalizeOpenAiModel(model);
  const target = normalizedModel
    ? `https://api.openai.com/v1/models/${encodeURIComponent(normalizedModel)}`
    : "https://api.openai.com/v1/models";

  try {
    const response = await fetch(target, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (response.ok) {
      return {
        ok: true,
        provider: "openai",
        model: normalizedModel,
        checkedAt,
        status: response.status,
        code: null,
        message: normalizedModel ? `Validated access to model ${normalizedModel}.` : "Validated OpenAI API key.",
      };
    }

    const bodyText = await response.text().catch(() => "");
    let code: string | null = null;
    let message = normalizedModel ? `OpenAI rejected model ${normalizedModel}.` : "OpenAI rejected the API key.";

    try {
      const parsed = JSON.parse(bodyText) as { error?: { code?: unknown; message?: unknown } };
      if (typeof parsed.error?.code === "string" && parsed.error.code.trim().length > 0) {
        code = parsed.error.code.trim();
      }
      if (typeof parsed.error?.message === "string" && parsed.error.message.trim().length > 0) {
        message = parsed.error.message.trim();
      }
    } catch {
      if (bodyText.trim().length > 0) {
        message = bodyText.trim();
      }
    }

    return {
      ok: false,
      provider: "openai",
      model: normalizedModel,
      checkedAt,
      status: response.status,
      code,
      message,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "openai",
      model: normalizedModel,
      checkedAt,
      status: null,
      code: "provider_unreachable",
      message: error instanceof Error ? error.message : "Could not reach OpenAI",
    };
  }
}
