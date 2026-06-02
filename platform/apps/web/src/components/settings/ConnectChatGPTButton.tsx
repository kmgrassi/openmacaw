import { useEffect, useRef, useState } from "react";

import {
  importOpenAICodexOAuth,
  pollOpenAICodexOAuth,
  startOpenAICodexOAuth,
} from "../../api/oauth";
import { devOpenAICodexAccessToken } from "../../lib/dev-credentials";
import { Button } from "../ui/Button";

type ConnectChatGPTButtonProps = {
  agentId: string;
  workspaceId: string | null;
  onConnected?: (info: {
    email: string | null;
    planType: string | null;
  }) => Promise<void> | void;
};

type FlowState =
  | { kind: "idle" }
  | { kind: "starting" }
  | {
      kind: "waiting";
      sessionId: string;
      verificationUrl: string;
      userCode: string;
      expiresAt: number;
      intervalMs: number;
    }
  | { kind: "success"; email: string | null; planType: string | null }
  | { kind: "error"; message: string };

const POLL_BUFFER_MS = 500;

export function ConnectChatGPTButton({
  agentId,
  workspaceId,
  onConnected,
}: ConnectChatGPTButtonProps) {
  const [state, setState] = useState<FlowState>({ kind: "idle" });
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const devAccessToken = devOpenAICodexAccessToken();

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  function clearPollTimer() {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  async function startFlow() {
    if (!workspaceId) {
      setState({ kind: "error", message: "Workspace context is required" });
      return;
    }
    setState({ kind: "starting" });
    try {
      const start = await startOpenAICodexOAuth({ agentId, workspaceId });
      const next: FlowState = {
        kind: "waiting",
        sessionId: start.sessionId,
        verificationUrl: start.verificationUrl,
        userCode: start.userCode,
        expiresAt: Date.now() + start.expiresInMs,
        intervalMs: start.intervalMs,
      };
      setState(next);
      schedulePoll(next.sessionId, next.intervalMs);
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function importDevToken() {
    if (!workspaceId || !devAccessToken) {
      setState({ kind: "error", message: "Dev OAuth token is not configured" });
      return;
    }
    setState({ kind: "starting" });
    try {
      const result = await importOpenAICodexOAuth({
        agentId,
        workspaceId,
        accessToken: devAccessToken,
      });
      setState({
        kind: "success",
        email: result.email,
        planType: result.planType,
      });
      await onConnected?.({ email: result.email, planType: result.planType });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function schedulePoll(sessionId: string, intervalMs: number) {
    clearPollTimer();
    pollTimerRef.current = setTimeout(() => {
      void pollOnce(sessionId, intervalMs);
    }, intervalMs + POLL_BUFFER_MS);
  }

  async function pollOnce(sessionId: string, intervalMs: number) {
    try {
      const result = await pollOpenAICodexOAuth(sessionId);
      if (result.status === "pending") {
        schedulePoll(sessionId, intervalMs);
        return;
      }
      if (result.status === "expired") {
        setState({
          kind: "error",
          message: "The code expired. Click Connect to try again.",
        });
        return;
      }
      if (result.status === "failed") {
        setState({ kind: "error", message: result.error });
        return;
      }
      // complete
      setState({
        kind: "success",
        email: result.email,
        planType: result.planType,
      });
      await onConnected?.({ email: result.email, planType: result.planType });
    } catch (error) {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function cancel() {
    clearPollTimer();
    setState({ kind: "idle" });
  }

  if (state.kind === "idle" || state.kind === "starting") {
    return (
      <div className="flex flex-col gap-2">
        <Button
          size="sm"
          disabled={!workspaceId || state.kind === "starting"}
          loading={state.kind === "starting"}
          onClick={() => void startFlow()}
        >
          Connect ChatGPT
        </Button>
        {devAccessToken && (
          <Button
            size="sm"
            variant="secondary"
            disabled={!workspaceId || state.kind === "starting"}
            onClick={() => void importDevToken()}
          >
            Use dev credentials
          </Button>
        )}
        <p className="text-xs text-slate-500">
          Sign in with your ChatGPT account to authorize Codex without an API
          key.
        </p>
      </div>
    );
  }

  if (state.kind === "waiting") {
    const remainingMin = Math.max(
      0,
      Math.round((state.expiresAt - Date.now()) / 60_000),
    );
    return (
      <ChatGPTDeviceCodeModal
        verificationUrl={state.verificationUrl}
        userCode={state.userCode}
        remainingMinutes={remainingMin}
        onCancel={cancel}
      />
    );
  }

  if (state.kind === "success") {
    return (
      <div className="rounded-md border border-emerald-700/40 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
        Connected{state.email ? ` as ${state.email}` : ""}
        {state.planType ? ` (${state.planType})` : ""}.
        <Button
          variant="ghost"
          size="sm"
          className="ml-3"
          onClick={() => setState({ kind: "idle" })}
        >
          Done
        </Button>
      </div>
    );
  }

  // error
  return (
    <div className="rounded-md border border-red-700/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
      {state.message}
      <Button
        variant="ghost"
        size="sm"
        className="ml-3"
        onClick={() => setState({ kind: "idle" })}
      >
        Dismiss
      </Button>
    </div>
  );
}

type ChatGPTDeviceCodeModalProps = {
  verificationUrl: string;
  userCode: string;
  remainingMinutes: number;
  onCancel: () => void;
};

function ChatGPTDeviceCodeModal({
  verificationUrl,
  userCode,
  remainingMinutes,
  onCancel,
}: ChatGPTDeviceCodeModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface-raised p-6 shadow-xl">
        <h3 className="text-base font-semibold text-slate-100">
          Authorize Codex with ChatGPT
        </h3>
        <ol className="mt-4 space-y-3 text-sm text-slate-300">
          <li>
            1. Open the URL below in your browser.
            <a
              className="mt-1 block break-all rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-blue-300 hover:bg-surface-overlay"
              href={verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {verificationUrl}
            </a>
          </li>
          <li>
            2. Enter this code on the OpenAI page:
            <div className="mt-1 select-all rounded-md border border-border bg-surface px-3 py-2 text-center font-mono text-xl tracking-[0.4em] text-slate-100">
              {userCode}
            </div>
          </li>
          <li>3. After you sign in, this dialog will close automatically.</li>
        </ol>
        <p className="mt-4 text-xs text-slate-500">
          Code expires in {remainingMinutes} minute
          {remainingMinutes === 1 ? "" : "s"}. Never share it.
        </p>
        <details className="mt-3 rounded-md border border-border bg-surface/60 px-3 py-2 text-xs text-slate-400">
          <summary className="cursor-pointer text-slate-300">
            Seeing "Enable device code authorization for Codex"?
          </summary>
          <div className="mt-2 space-y-2 leading-relaxed">
            <p>
              OpenAI requires your ChatGPT account to opt in to device-code
              logins before the verification page will accept the code. This is
              a one-time account setting; once enabled, every future device-code
              sign-in works.
            </p>
            <ol className="ml-4 list-decimal space-y-1">
              <li>
                Open{" "}
                <a
                  className="text-blue-300 hover:underline"
                  href="https://chatgpt.com/#settings/Security"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ChatGPT Settings → Security
                </a>{" "}
                (or Data Controls, depending on plan).
              </li>
              <li>
                Find the toggle labeled{" "}
                <em>Device code authorization for Codex</em> (or similar).
                Enable it.
              </li>
              <li>
                Return here and re-enter the code{" "}
                <span className="font-mono text-slate-300">{userCode}</span>, or
                press Cancel and start over.
              </li>
            </ol>
            <p>
              If you can't find the toggle (some plans don't expose it), tell
              the platform team — we have a fallback path that imports OAuth
              tokens from the openclaw CLI instead.
            </p>
          </div>
        </details>
        <div className="mt-5 flex justify-end">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
