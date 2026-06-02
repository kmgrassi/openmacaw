import type { Express } from "express";

import {
  GitHubAppInstallationCredentialRequestSchema,
  GitHubAppInstallationCredentialResponseSchema,
} from "../../../../contracts/resource-credentials.js";
import { apiRoute } from "../http.js";
import { saveGitHubAppInstallationCredentialForWorkspace } from "../services/resource-credentials.js";

export function registerResourceCredentialRoutes(app: Express) {
  app.post(
    "/api/resource-credentials/github-app-installations",
    apiRoute({
      requireAuth: true,
      bodySchema: GitHubAppInstallationCredentialRequestSchema,
      invalidBodyMessage: "GitHub App installation credential details are required",
      handler: async ({ body, res, userId }) => {
        const credential = await saveGitHubAppInstallationCredentialForWorkspace({
          userId: userId ?? null,
          credential: body,
        });

        return res.status(200).json(
          GitHubAppInstallationCredentialResponseSchema.parse({
            credential,
          }),
        );
      },
    }),
  );
}
