import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAgentMessages,
  type ChatMessage,
  type ChatMessagesPage,
} from "../api/messages";
import { invalidateRuntimeQueries } from "../api/query-invalidation";
import { queryKeys } from "../api/query-keys";
import type {
  AgentId,
  ChatAbortParams,
  ChatSendParams,
  ChatSendResult,
  RuntimeScope,
  SessionKey,
  WsScopeFields,
} from "../api/ws-types";

type GatewayRequest = <T = unknown>(
  method: string,
  params?: unknown,
) => Promise<T>;

export function useMessagesQuery(
  agentId: AgentId,
  sessionKey: SessionKey | string | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: sessionKey
      ? queryKeys.messages.history(agentId, sessionKey)
      : queryKeys.messages.history(agentId, "__missing_session__"),
    queryFn: () => fetchAgentMessages(agentId),
    enabled: Boolean(agentId && sessionKey && (options.enabled ?? true)),
  });
}

export function prependOlderMessages(
  current: ChatMessagesPage | undefined,
  olderPage: ChatMessagesPage,
): ChatMessagesPage {
  if (!current) return olderPage;

  const existingIds = new Set(
    current.messages.map((message) => message.id).filter(Boolean),
  );
  const older = olderPage.messages.filter(
    (message) => !message.id || !existingIds.has(message.id),
  );

  return {
    messages: [...older, ...current.messages],
    pageInfo: olderPage.pageInfo,
  };
}

export function useSendMessageMutation(input: {
  agentId: AgentId;
  scope: RuntimeScope | null;
  sessionKey: SessionKey | string | null;
  request: GatewayRequest;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (inputMessage: {
      message: string;
      idempotencyKey: string;
    }) => {
      if (!input.sessionKey || !input.scope) {
        throw new Error("Runtime is starting. Retry in a moment.");
      }

      const wireScope: WsScopeFields = {
        agent_id: input.agentId,
        workspace_id: input.scope.workspaceId,
      };
      const params: ChatSendParams = {
        ...wireScope,
        sessionKey: input.sessionKey as SessionKey,
        message: inputMessage.message,
        deliver: false,
        idempotencyKey: inputMessage.idempotencyKey,
      };
      const result = await input.request<ChatSendResult>("chat.send", params);
      return { result, idempotencyKey: inputMessage.idempotencyKey };
    },
    onMutate: async (inputMessage) => {
      if (!input.sessionKey) return undefined;
      const queryKey = queryKeys.messages.history(
        input.agentId,
        input.sessionKey,
      );
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ChatMessagesPage>(queryKey);
      const optimisticMessage: ChatMessage = {
        role: "user",
        content: inputMessage.message,
        timestamp: Date.now(),
      };
      queryClient.setQueryData<ChatMessagesPage>(queryKey, (current) => ({
        messages: [...(current?.messages ?? []), optimisticMessage],
        pageInfo: current?.pageInfo ?? {
          limit: 30,
          hasMore: false,
          nextCursor: null,
        },
      }));
      return { previous, queryKey };
    },
    onError: (_error, _message, context) => {
      if (context?.queryKey) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
  });
}

export function useAbortMessageMutation(input: {
  agentId: AgentId;
  scope: RuntimeScope | null;
  sessionKey: SessionKey | string | null;
  request: GatewayRequest;
  getRunId: () => string | null;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!input.sessionKey || !input.scope) return;
      const params: ChatAbortParams = {
        agent_id: input.agentId,
        workspace_id: input.scope.workspaceId,
        sessionKey: input.sessionKey as SessionKey,
        ...(input.getRunId() ? { runId: input.getRunId() ?? undefined } : {}),
      };
      await input.request("chat.abort", params);
    },
    onSettled: async () => {
      await invalidateRuntimeQueries(
        queryClient,
        input.agentId,
        input.sessionKey ?? undefined,
      );
    },
  });
}
