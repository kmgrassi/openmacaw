import { useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { extractPrimaryModel } from "../../../../../contracts/agent-helpers";
import type { SetupConfigurationChecklistItem } from "../../../../../contracts/setup";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { statusToneClass, statusToneForValue } from "../ui/status-tones";
import type { DashboardSetup } from "./dashboardTypes";
import { InlineCredentialForm } from "./InlineCredentialForm";

type ConfigurationStatusCardProps = {
  setup: DashboardSetup;
  onConfigured: (setup: DashboardSetup) => void;
};

type ChecklistItem = SetupConfigurationChecklistItem;

const ACTION_LABELS: Record<string, string> = {
  add_credential: "Add Credentials",
  configure_runtime: "Configure Runtime",
  configure_agent: "Configure Agent",
  configure_runner: "Configure Runner",
  configure_routing: "Configure Routing",
  configure_route: "Configure Routing",
  select_model: "Select Model",
};

function fallbackChecklist(setup: DashboardSetup): ChecklistItem[] {
  const missing = new Set(setup.requirements.missing);
  const profile = setup.requirements.executionProfile?.profile;
  const model =
    profile?.model ?? extractPrimaryModel(setup.agent.modelSettings);

  return [
    {
      step: "agent_exists",
      status: missing.has("agent") ? "fail" : "pass",
      label: "Agent created",
      action: "configure_agent",
      actionUrl: `/settings/agents/${setup.agent.id}`,
    },
    {
      step: "model_selected",
      status: missing.has("model") || missing.has("provider") ? "fail" : "pass",
      label: model ? `Model selected: ${model}` : "Model selected",
      action: "select_model",
      actionUrl: `/settings/agents/${setup.agent.id}`,
    },
    {
      step: "credential_configured",
      status: missing.has("credential") ? "fail" : "pass",
      label: "API key configured",
      action: "add_credential",
      actionUrl: `/settings/agents/${setup.agent.id}`,
    },
    {
      step: "routing_rule",
      status: missing.has("runner") || missing.has("route") ? "fail" : "pass",
      label: "Routing rule matched",
      action: missing.has("route") ? "configure_route" : "configure_runner",
      actionUrl: `/settings/agents/${setup.agent.id}`,
    },
    {
      step: "launcher_ready",
      status: missing.has("gateway_config") ? "fail" : "pass",
      label: "Gateway configuration ready",
      action: "configure_runtime",
      actionUrl: "/settings/runtime",
    },
  ];
}

function actionUrlFor(item: ChecklistItem, agentId: string): string {
  const explicitUrl = item.actionUrl?.replace("{agentId}", agentId);
  if (explicitUrl) return explicitUrl;

  if (item.action === "configure_runtime") return "/settings/runtime";
  return `/settings/agents/${agentId}`;
}

function actionLabelFor(item: ChecklistItem): string {
  if (!item.action) return "Resolve";
  return ACTION_LABELS[item.action] ?? "Resolve";
}

function StatusIcon({ status }: { status: ChecklistItem["status"] }) {
  const isPass = status === "pass";
  const tone = statusToneForValue(status);

  return (
    <span
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${statusToneClass(
        tone,
        "panel",
      )}`}
      aria-hidden="true"
    >
      {isPass ? (
        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none">
          <path
            d="M3.5 8.2 6.5 11 12.5 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none">
          <path
            d="m4.5 4.5 7 7m0-7-7 7"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </span>
  );
}

export function ConfigurationStatusCard({
  setup,
  onConfigured,
}: ConfigurationStatusCardProps) {
  const navigate = useNavigate();
  const checklist = useMemo(
    () =>
      setup.requirements.checklist?.length
        ? setup.requirements.checklist
        : fallbackChecklist(setup),
    [setup],
  );
  const failedCount = checklist.filter((item) => item.status === "fail").length;
  const hasMissingCredential = checklist.some(
    (item) =>
      item.status === "fail" &&
      (item.action === "add_credential" ||
        item.step === "credential_configured"),
  );

  return (
    <Card className="border-slate-800/60 bg-slate-900/45 shadow-none">
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Agent Configuration
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            {failedCount === 1
              ? "One setup item needs attention before chat can start."
              : `${failedCount} setup items need attention before chat can start.`}
          </p>
        </div>
      </div>

      <div className="divide-y divide-slate-800/70 overflow-hidden rounded-md border border-slate-800/70">
        {checklist.map((item) => (
          <div
            key={item.step}
            className="flex flex-col gap-3 bg-slate-950/25 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-center gap-3">
              <StatusIcon status={item.status} />
              <div className="min-w-0">
                <div className="truncate text-sm text-slate-100">
                  {item.label}
                </div>
                <div className="text-xs text-slate-500">
                  {item.status === "pass" ? "Ready" : "Required"}
                </div>
              </div>
            </div>

            {item.status === "fail" && item.action !== "add_credential" && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="w-full sm:w-auto"
                onClick={() => navigate(actionUrlFor(item, setup.agent.id))}
              >
                {actionLabelFor(item)}
              </Button>
            )}
          </div>
        ))}
      </div>

      {hasMissingCredential && (
        <InlineCredentialForm setup={setup} onConfigured={onConfigured} />
      )}
    </Card>
  );
}
