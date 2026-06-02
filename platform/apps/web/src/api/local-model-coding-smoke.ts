import {
  LocalModelCodingSmokeResponseSchema,
  type LocalModelCodingSmokeResponse,
} from "../../../../contracts/local-model-coding-smoke";
import { resolveBrokerBase } from "./broker";
import { brokerFetch } from "./broker-fetch";
import { ROUTES } from "./routes";

export async function getLocalModelCodingSmoke(): Promise<LocalModelCodingSmokeResponse> {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.localModelCodingSmoke}`,
    {
      method: "GET",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to load local model coding smoke fixture (${response.status})${text ? `: ${text}` : ""}`,
    );
  }

  return LocalModelCodingSmokeResponseSchema.parse(await response.json());
}
