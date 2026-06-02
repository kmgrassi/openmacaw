import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  draftPlanFromPrompt,
  type PlanDraft,
  type PlanTaskDraft,
} from "../../api/plans";
import { useCreatePlanMutation } from "../../api/query-hooks";
import { AppShell } from "../../components/AppShell";
import { Alert } from "../../components/ui/Alert";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Textarea } from "../../components/ui/Textarea";
import { useAuthStore } from "../../stores/auth";
import { TaskEditor } from "./NewPlan/TaskEditor";
import { emptyTask, validateDraft } from "./NewPlan/draft-helpers";

export function NewPlan() {
  const navigate = useNavigate();
  const workspaceId = useAuthStore((state) => state.workspaceId);
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createPlanMutation = useCreatePlanMutation(workspaceId);
  const creating = createPlanMutation.isPending;

  const validationError = useMemo(
    () => (draft ? validateDraft(draft) : null),
    [draft],
  );

  async function handleDraft() {
    if (!workspaceId || !prompt.trim()) return;
    setLoadingDraft(true);
    setError(null);
    try {
      const response = await draftPlanFromPrompt({
        workspaceId: workspaceId,
        prompt: prompt.trim(),
      });
      setDraft(response.draft);
    } catch (draftError) {
      setError((draftError as Error).message);
    } finally {
      setLoadingDraft(false);
    }
  }

  async function handleApprove() {
    if (!workspaceId || !draft || validationError) return;
    setError(null);
    try {
      const response = await createPlanMutation.mutateAsync(draft);
      navigate(`/plans/${response.plan.id}`);
    } catch (createError) {
      setError((createError as Error).message);
    }
  }

  function updateTask(index: number, task: PlanTaskDraft) {
    if (!draft) return;
    setDraft({
      ...draft,
      tasks: draft.tasks.map((candidate, candidateIndex) =>
        candidateIndex === index ? task : candidate,
      ),
    });
  }

  function removeTask(index: number) {
    if (!draft || draft.tasks.length <= 1) return;
    const removedId = draft.tasks[index]?.id;
    setDraft({
      ...draft,
      tasks: draft.tasks
        .filter((_, candidateIndex) => candidateIndex !== index)
        .map((task) => ({
          ...task,
          dependsOn: removedId
            ? task.dependsOn.filter((dependency) => dependency !== removedId)
            : task.dependsOn,
        })),
    });
  }

  function addTask() {
    if (!draft) return;
    setDraft({ ...draft, tasks: [...draft.tasks, emptyTask(draft.tasks)] });
  }

  return (
    <AppShell>
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.28em] text-slate-500">
              Plans
            </div>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
              Create plan
            </h1>
          </div>
          {draft && <Badge variant="default">{draft.tasks.length} tasks</Badge>}
        </div>

        {!workspaceId && (
          <Alert tone="warning" className="rounded-lg px-4 py-3">
            Workspace context is required before a plan can be created.
          </Alert>
        )}
        {error && (
          <Alert tone="error" className="rounded-lg px-4 py-3">
            {error}
          </Alert>
        )}

        <Card className="border-slate-800 bg-slate-900/70">
          <div className="space-y-4">
            <Textarea
              label="Describe what you want."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder="Clean up unused imports across src, split work by directory, and run lint and tests."
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => void handleDraft()}
                loading={loadingDraft}
                disabled={!workspaceId || !prompt.trim()}
              >
                {draft ? "Regenerate" : "Draft plan"}
              </Button>
              {draft && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setDraft(null)}
                  disabled={loadingDraft || creating}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </Card>

        {draft && (
          <div className="space-y-5">
            <Card className="border-slate-800 bg-slate-900/70">
              <div className="grid gap-4 lg:grid-cols-3">
                <Input
                  label="Plan title"
                  value={draft.title}
                  error={draft.title.trim() ? undefined : "Title is required."}
                  onChange={(event) =>
                    setDraft({ ...draft, title: event.target.value })
                  }
                />
                <Input
                  label="Default runner"
                  value={draft.defaultRunner ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      defaultRunner: event.target.value || undefined,
                    })
                  }
                />
                <Input
                  label="Default model"
                  value={draft.defaultModel ?? ""}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      defaultModel: event.target.value || undefined,
                    })
                  }
                />
              </div>
              <Textarea
                label="Intent"
                value={draft.intent}
                onChange={(event) =>
                  setDraft({ ...draft, intent: event.target.value })
                }
                rows={3}
                wrapperClassName="mt-4"
              />
            </Card>

            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-100">Tasks</h2>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={addTask}
                >
                  Add task
                </Button>
              </div>
              {draft.tasks.map((task, index) => (
                <TaskEditor
                  key={`${task.id}:${index}`}
                  task={task}
                  allTasks={draft.tasks}
                  canRemove={draft.tasks.length > 1}
                  onChange={(nextTask) => updateTask(index, nextTask)}
                  onRemove={() => removeTask(index)}
                />
              ))}
            </div>

            <div className="sticky bottom-0 -mx-6 border-t border-border bg-slate-950/95 px-6 py-4 backdrop-blur">
              <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-slate-400">
                  {validationError ?? "Draft is ready to approve."}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setDraft(null)}
                    disabled={creating}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void handleApprove()}
                    loading={creating}
                    disabled={Boolean(validationError)}
                  >
                    Approve
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
