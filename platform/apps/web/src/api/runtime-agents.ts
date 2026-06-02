import { resolveBrokerBase } from "./broker";
import { brokerFetch } from "./broker-fetch";
import { ROUTES } from "./routes";

export async function fetchRuntimeAgents() {
  const response = await brokerFetch(`${resolveBrokerBase()}${ROUTES.agents}`, {
    method: "GET",
  });

  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text || {};
  }

  if (!response.ok) {
    throw new Error(`Runtime agent list failed (${response.status})`);
  }

  return body;
}
