import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { AgentMessageToolCall } from "../../../../contracts/messages";
import { getManagerSchedulerMessageDisplay } from "../lib/manager-message-rendering";
import {
  formatPersistedToolCalls,
  type ToolCallDisplay,
} from "../lib/tool-call-rendering";

type Props = {
  role: string;
  content: string;
  metadata?: unknown;
  toolCalls?: AgentMessageToolCall[];
  timestamp?: number;
  pending?: boolean;
};

function PendingEllipsis() {
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setDotCount((current) => (current === 3 ? 1 : current + 1));
    }, 450);

    return () => window.clearInterval(interval);
  }, []);

  return (
    <span
      aria-label="Assistant response pending"
      className="inline-block w-[3ch] text-slate-400"
    >
      {".".repeat(dotCount)}
    </span>
  );
}

function ToolCallList({ toolCalls }: { toolCalls: ToolCallDisplay[] }) {
  if (toolCalls.length === 0) return null;

  return (
    <div className="mt-2 space-y-1.5">
      {toolCalls.map((toolCall, index) => (
        <div
          key={`${toolCall.label}-${index}`}
          className="rounded border border-cyan-900/60 bg-cyan-950/25 px-2 py-1.5 text-xs text-cyan-50"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{toolCall.label}</span>
            {toolCall.status && (
              <span className="rounded border border-cyan-800/60 px-1.5 py-0.5 text-[10px] uppercase text-cyan-200">
                {toolCall.status}
              </span>
            )}
          </div>
          {toolCall.inputSummary && (
            <div className="mt-1 break-words font-mono text-[11px] leading-snug text-cyan-100/80">
              Input: {toolCall.inputSummary}
            </div>
          )}
          {toolCall.outputSummary && (
            <div className="mt-1 break-words font-mono text-[11px] leading-snug text-cyan-100/70">
              Output: {toolCall.outputSummary}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ChatMessage({
  role,
  content,
  metadata,
  toolCalls,
  timestamp,
  pending = false,
}: Props) {
  const managerDisplay = useMemo(
    () => getManagerSchedulerMessageDisplay(content, metadata, toolCalls),
    [content, metadata, toolCalls],
  );
  const persistedToolCallDisplay = useMemo(
    () => (managerDisplay ? [] : formatPersistedToolCalls(toolCalls)),
    [managerDisplay, toolCalls],
  );
  const html = useMemo(() => {
    if (pending) return "";
    if (managerDisplay) return "";
    if (!content) return "";
    const raw = marked.parse(content, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [content, managerDisplay, pending]);

  const isUser = role === "user";
  const time = timestamp
    ? new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div
      className={`group flex min-w-0 ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`min-w-0 max-w-[88%] text-sm leading-relaxed sm:max-w-[min(44rem,84%)] ${
          isUser
            ? "rounded-xl border border-blue-400/20 bg-blue-500/18 px-3.5 py-2.5 text-blue-50 shadow-sm"
            : "border-l border-slate-800/80 px-3 py-1.5 text-slate-200"
        }`}
      >
        {pending ? (
          <div className="prose prose-sm prose-invert max-w-none">
            <PendingEllipsis />
          </div>
        ) : managerDisplay ? (
          <div className="space-y-2">
            <div className="font-medium text-slate-100">
              {managerDisplay.summary}
            </div>
            {managerDisplay.workItemIds.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {managerDisplay.workItemIds.map((workItemId) => (
                  <span
                    key={workItemId}
                    className="rounded border border-slate-700 bg-slate-900/60 px-1.5 py-0.5 font-mono text-[11px] text-slate-300"
                  >
                    {workItemId}
                  </span>
                ))}
              </div>
            )}
            {managerDisplay.toolCalls.length > 0 && (
              <ToolCallList toolCalls={managerDisplay.toolCalls} />
            )}
            {managerDisplay.rawPayload && (
              <details className="rounded border border-slate-800 bg-black/20 px-2 py-1.5">
                <summary className="cursor-pointer text-xs font-medium text-slate-400">
                  Raw payload
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-slate-300">
                  {managerDisplay.rawPayload}
                </pre>
              </details>
            )}
          </div>
        ) : (
          <div
            className="prose prose-sm prose-invert max-w-none [overflow-wrap:anywhere] [&_a]:text-blue-200 [&_a]:underline [&_a]:decoration-blue-300/50 [&_code]:text-xs [&_ol]:my-2 [&_p]:my-0 [&_p+p]:mt-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/30 [&_pre]:p-3 [&_ul]:my-2"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {!pending && persistedToolCallDisplay.length > 0 && (
          <ToolCallList toolCalls={persistedToolCallDisplay} />
        )}
        {time && (
          <div
            className={`mt-1.5 text-right text-[10px] leading-none opacity-0 transition-opacity group-hover:opacity-100 ${
              isUser ? "text-blue-200/65" : "text-slate-600"
            }`}
          >
            {time}
          </div>
        )}
      </div>
    </div>
  );
}
