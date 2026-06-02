/**
 * Web-side helper for the dev-only local-models endpoint registered by
 * apps/api/src/routes/local-models.ts. Used by AgentRuntimeEditor to
 * populate a model dropdown when the user picks a local provider.
 */
import { brokerFetch } from "./broker-fetch";

export type InstalledLocalModel = {
  name: string;
  family: string | null;
  parameterSize: string | null;
  quantizationLevel: string | null;
  sizeBytes: number | null;
  modifiedAt: string | null;
};

export type ListInstalledLocalModelsResult =
  | { ok: true; host: string; models: InstalledLocalModel[] }
  | { ok: false; error: string };

export async function listInstalledLocalModels(): Promise<ListInstalledLocalModelsResult> {
  try {
    const res = await brokerFetch("/api/local/installed-models", {
      method: "GET",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `${res.status} ${body}` };
    }
    const body = (await res.json()) as
      | { host: string; models: InstalledLocalModel[] }
      | { error: { code: string; message: string } };
    if ("error" in body) {
      return { ok: false, error: body.error.message };
    }
    return { ok: true, host: body.host, models: body.models };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
