export async function fetchLinearProjectIssues(input: { apiKey: string; projectId: string; after?: string | null }) {
  const query = `
    query ProjectIssues($projectId: String!, $after: String) {
      project(id: $projectId) {
        id
        name
        issues(first: 50, after: $after, orderBy: updatedAt) {
          nodes {
            id
            identifier
            title
            description
            priority
            priorityLabel
            url
            labels {
              nodes {
                name
              }
            }
            state {
              name
              type
            }
            team {
              id
              key
              name
            }
            project {
              id
              name
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      query,
      variables: {
        projectId: input.projectId,
        after: input.after ?? null,
      },
    }),
  });

  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    throw new Error(`Linear project query failed (${response.status})${payload ? `: ${payload}` : ""}`);
  }

  const payload = (await response.json()) as {
    data?: {
      project?: {
        id: string;
        name: string;
        issues?: {
          nodes?: Array<Record<string, unknown>>;
          pageInfo?: {
            hasNextPage?: boolean;
            endCursor?: string | null;
          };
        };
      } | null;
    };
    errors?: Array<{ message?: string }>;
  };

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message || "Unknown Linear GraphQL error").join("; "));
  }

  return {
    project: payload.data?.project ?? null,
    issues: payload.data?.project?.issues?.nodes ?? [],
    pageInfo: payload.data?.project?.issues?.pageInfo ?? {
      hasNextPage: false,
      endCursor: null,
    },
  };
}
