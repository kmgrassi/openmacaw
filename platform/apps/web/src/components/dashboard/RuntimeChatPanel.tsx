import type { AuthStateAgent } from "../../api/ws-types";
import type { RuntimeScope } from "../../api/ws-types";
import {
  GatewayProvider,
  useGatewayContext,
} from "../../context/GatewayContext";
import { ChatView } from "../ChatView";
import { LauncherConfigErrorBanner } from "./LauncherConfigErrorBanner";

type RuntimeChatPanelProps = {
  scope: RuntimeScope | null;
  target: AuthStateAgent | null;
  loading: boolean;
  hasCredentials?: boolean;
  gatewayProvided?: boolean;
};

function PrepareErrorSlot() {
  const { prepareError, clearPrepareError } = useGatewayContext();
  if (!prepareError) return null;
  return (
    <div className="border-b border-slate-800/70 px-4 py-3">
      <LauncherConfigErrorBanner
        error={prepareError}
        onDismiss={clearPrepareError}
      />
    </div>
  );
}

export function RuntimeChatPanel({
  scope,
  target,
  loading,
  hasCredentials = true,
  gatewayProvided = false,
}: RuntimeChatPanelProps) {
  const chatContent = scope ? (
    <>
      <PrepareErrorSlot />
      <div className="h-full min-h-0">
        <ChatView
          agentId={scope.agentId}
          sessionKey={scope.sessionKey}
          workspaceId={scope.workspaceId}
          hasCredentials={hasCredentials}
        />
      </div>
    </>
  ) : null;

  return (
    <div className="h-full min-h-0 overflow-hidden">
      {scope ? (
        gatewayProvided ? (
          chatContent
        ) : (
          <GatewayProvider scopeOverride={scope} targetOverride={target}>
            {chatContent}
          </GatewayProvider>
        )
      ) : (
        <div className="flex h-full min-h-[24rem] items-center justify-center text-sm text-slate-500">
          {loading ? "Loading runtime scope..." : "Runtime scope unavailable."}
        </div>
      )}
    </div>
  );
}
