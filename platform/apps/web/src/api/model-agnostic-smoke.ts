import {
  ModelAgnosticSmokeResponseSchema,
  type ModelAgnosticSmokeResponse,
} from "../../../../contracts/model-agnostic-smoke";
import { resolveBrokerBase } from "./broker";
import { brokerFetch } from "./broker-fetch";
import { ROUTES } from "./routes";

export async function getModelAgnosticSmoke(): Promise<ModelAgnosticSmokeResponse> {
  const response = await brokerFetch(
    `${resolveBrokerBase()}${ROUTES.modelAgnosticSmoke}`,
    {
      method: "GET",
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to load model-agnostic smoke fixture (${response.status})${text ? `: ${text}` : ""}`,
    );
  }

  return ModelAgnosticSmokeResponseSchema.parse(await response.json());
}
