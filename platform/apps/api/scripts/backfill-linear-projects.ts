import "dotenv/config";

import { loadApiConfig } from "../src/config.js";
import {
  fetchLinearProjectIssues,
  normalizeLinearWebhook,
  upsertWorkItemFromNormalizedInput,
} from "../src/services/work-item-ingest.js";

async function main() {
  const config = loadApiConfig();
  const projectIds = process.argv.slice(2).map((value) => value.trim()).filter((value) => value.length > 0);

  if (!config.linearApiKey) {
    throw new Error("LINEAR_API_KEY is required");
  }
  if (projectIds.length === 0) {
    throw new Error("Pass at least one Linear project ID");
  }

  const routing = {
    defaultWorkspaceId: config.workItemDefaultWorkspaceId,
    githubRepoWorkspaceMap: config.githubRepoWorkspaceMap,
    linearProjectWorkspaceMap: config.linearProjectWorkspaceMap,
    linearTeamWorkspaceMap: config.linearTeamWorkspaceMap,
  };

  let total = 0;
  for (const projectId of projectIds) {
    let after: string | null = null;
    let page = 0;

    while (true) {
      page += 1;
      const result = await fetchLinearProjectIssues({
        apiKey: config.linearApiKey,
        projectId,
        after,
      });

      for (const issue of result.issues) {
        const normalized = normalizeLinearWebhook({
          eventName: "Issue",
          deliveryId: null,
          payload: {
            action: "update",
            type: "Issue",
            url: typeof issue.url === "string" ? issue.url : null,
            data: issue,
          },
        }, routing);

        if (!normalized) {
          continue;
        }

        await upsertWorkItemFromNormalizedInput(normalized);
        total += 1;
      }

      console.log(`project=${projectId} page=${page} issues=${result.issues.length}`);

      if (!result.pageInfo?.hasNextPage || !result.pageInfo?.endCursor) {
        break;
      }
      after = result.pageInfo.endCursor;
    }
  }

  console.log(`backfilled ${total} Linear issues`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
