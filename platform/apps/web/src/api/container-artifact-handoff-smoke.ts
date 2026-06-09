import {
  AwsResourceAccessSmokeResponseSchema,
  type AwsResourceAccessSmokeResponse,
} from "../../../../contracts/aws-resource-access-smoke";
import { apiFetch } from "./client";
import { ROUTES } from "./routes";

export function getContainerArtifactHandoffSmoke() {
  return apiFetch<AwsResourceAccessSmokeResponse>(
    ROUTES.containerArtifactHandoffSmoke,
    {
      schema: AwsResourceAccessSmokeResponseSchema,
      defaultErrorMessage: (status) =>
        `container artifact handoff smoke request failed (${status})`,
    },
  );
}
