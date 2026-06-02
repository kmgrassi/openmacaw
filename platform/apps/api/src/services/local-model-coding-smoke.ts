import {
  LocalModelCodingSmokeResponseSchema,
  type LocalModelCodingSmokeResponse,
} from "../../../../contracts/local-model-coding-smoke.js";

type LocalModelCodingSmokeInput = {
  model?: string;
  approvalPolicy?: string;
};

const SECRET_PATTERNS = [/api[_-]?key/i, /token/i, /secret/i, /(^|[^a-z])sk-[a-z0-9-]{6,}/i];

function cleanModel(value: string | undefined) {
  const candidate = value?.trim();
  if (!candidate || SECRET_PATTERNS.some((pattern) => pattern.test(candidate))) {
    return "qwen2.5-coder:latest";
  }
  return candidate;
}

function cleanApprovalPolicy(value: string | undefined): "never" | "on-request" | "on-failure" {
  return value === "never" || value === "on-failure" ? value : "on-request";
}

function assertNoSecrets(payload: LocalModelCodingSmokeResponse) {
  const serialized = JSON.stringify(payload);
  const leaked = SECRET_PATTERNS.find((pattern) => pattern.test(serialized));
  if (leaked) {
    throw new Error(`Local model coding smoke payload contains secret-like text: ${leaked}`);
  }
}

export function buildLocalModelCodingSmokeHarness(
  input: LocalModelCodingSmokeInput = {},
): LocalModelCodingSmokeResponse {
  const model = cleanModel(input.model);
  const approvalPolicy = cleanApprovalPolicy(input.approvalPolicy);
  const changedFile = "README.md";
  const before = "# Disposable smoke repo\n";
  const after = "# Disposable smoke repo\n\nLocal coding smoke passed.\n";

  const response = LocalModelCodingSmokeResponseSchema.parse({
    scenario: "local-model-coding-runner-end-to-end",
    liveProviderCalls: false,
    profile: {
      role: "coding",
      runnerKind: "local_model_coding",
      provider: "openai_compatible",
      model,
      credentialRef: {
        type: "alias",
        value: "local-runtime:qwen",
      },
      toolProfile: "coding",
      workspacePolicy: {
        sandbox: "workspace-write",
        approvalPolicy,
      },
      capabilityRequirements: {
        toolCalls: true,
        jsonMode: true,
      },
    },
    runtimeDispatch: {
      endpoint: "runtime-local-loopback",
      accepted: true,
      runner: "local_model_coding",
    },
    workspaceMutation: {
      disposableRepo: "tmp/local-model-coding-smoke",
      changedFile,
      before,
      after,
      diff: [
        "diff --git a/README.md b/README.md",
        "index 8f3f0a1..c6a6078 100644",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1,3 @@",
        " # Disposable smoke repo",
        "+",
        "+Local coding smoke passed.",
      ].join("\n"),
    },
    toolCalls: [
      {
        id: "tool-call-shell-readme",
        toolSlug: "shell.exec",
        status: "completed",
        commandActions: ["read"],
        arguments: {
          cmd: "sed -n '1,40p' README.md",
          cwd: "tmp/local-model-coding-smoke",
        },
        result: {
          exitCode: 0,
          stdoutPreview: before,
          stderrPreview: "",
        },
      },
      {
        id: "tool-call-apply-patch-readme",
        toolSlug: "apply_patch",
        status: "completed",
        commandActions: [],
        arguments: {
          file: changedFile,
          patchSummary: "Append local coding smoke marker.",
        },
        result: {
          filesChanged: [changedFile],
          diffPreview: "+Local coding smoke passed.",
        },
      },
      {
        id: "tool-call-shell-diff",
        toolSlug: "shell.exec",
        status: "completed",
        commandActions: ["unknown"],
        arguments: {
          cmd: "git diff -- README.md",
          cwd: "tmp/local-model-coding-smoke",
        },
        result: {
          exitCode: 0,
          stdoutPreview: "+Local coding smoke passed.",
          stderrPreview: "",
        },
      },
    ],
    events: [
      {
        phase: "platform_profile_resolved",
        source: "platform",
        message: `Resolved coding profile to openai_compatible/${model}.`,
      },
      {
        phase: "runtime_dispatch_accepted",
        source: "runtime",
        message: "Runtime accepted the local_model_coding dispatch with workspace-write policy.",
      },
      {
        phase: "local_model_tool_call",
        source: "local_model",
        message: "Local model requested shell.exec followed by apply_patch.",
      },
      {
        phase: "shell_exec_completed",
        source: "tool",
        message: "shell.exec read the disposable repo README successfully.",
      },
      {
        phase: "apply_patch_completed",
        source: "tool",
        message: "apply_patch wrote the README smoke marker.",
      },
      {
        phase: "workspace_diff_surfaced",
        source: "platform",
        message: "Platform received the changed file summary and diff preview.",
      },
      {
        phase: "ui_events_ready",
        source: "ui",
        message: "Browser smoke panel can render profile, tool calls, events, and diff.",
      },
    ],
    browserChecks: [
      "Open /settings/agents and load the Local Model Coding Smoke fixture.",
      "Verify runner kind, model, approval policy, tool calls, and diff preview are visible.",
      "Check the browser console for errors after loading the fixture.",
    ],
    localFlow: [
      "Start Ollama or another OpenAI-compatible local model endpoint.",
      "Start parallel-agent-runtime with the local_model_coding runner enabled.",
      "Start this platform with pnpm run dev and log in with dev credentials.",
      "Run the disposable-repo smoke from the runtime repo, then verify Platform shows the same tool calls and diff events.",
    ],
  });

  assertNoSecrets(response);
  return response;
}
