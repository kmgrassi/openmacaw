/** Reach an Ollama-compatible endpoint and return available model names. */
export async function probeOllamaEndpoint(
  endpoint: string,
  timeoutMs = 3_000,
): Promise<{ reachable: boolean; models: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = endpoint.replace(/\/+$/, "");
    const res = await fetch(`${url}/api/tags`, { signal: controller.signal });
    if (!res.ok) {
      return { reachable: true, models: [] };
    }
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (body.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}
