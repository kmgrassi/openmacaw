import { useEffect, useState } from "react";

import {
  COMPLETION_GATES,
  type CompletionGate,
  type PlanTaskDraft,
} from "../../../api/plans";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { Checkbox } from "../../../components/ui/Checkbox";
import { Input } from "../../../components/ui/Input";
import { Textarea } from "../../../components/ui/Textarea";
import { labelsToText, taskErrors, textToLabels } from "./draft-helpers";

type TaskEditorProps = {
  task: PlanTaskDraft;
  allTasks: PlanTaskDraft[];
  onChange: (task: PlanTaskDraft) => void;
  onRemove: () => void;
  canRemove: boolean;
};

export function TaskEditor({
  task,
  allTasks,
  onChange,
  onRemove,
  canRemove,
}: TaskEditorProps) {
  const errors = taskErrors(task);
  const [rawLabels, setRawLabels] = useState(() => labelsToText(task.labels));
  const dependencyOptions = allTasks.filter(
    (candidate) => candidate.id !== task.id,
  );

  useEffect(() => {
    setRawLabels(labelsToText(task.labels));
  }, [task.id, task.labels]);

  function commitLabels(value: string) {
    onChange({ ...task, labels: textToLabels(value) });
  }

  function toggleGate(gate: CompletionGate) {
    onChange({
      ...task,
      completionGates: task.completionGates.includes(gate)
        ? task.completionGates.filter((item) => item !== gate)
        : [...task.completionGates, gate],
    });
  }

  function toggleDependency(taskId: string) {
    onChange({
      ...task,
      dependsOn: task.dependsOn.includes(taskId)
        ? task.dependsOn.filter((item) => item !== taskId)
        : [...task.dependsOn, taskId],
    });
  }

  return (
    <Card className="border-slate-800 bg-slate-900/70">
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-[150px,minmax(0,1fr)]">
          <Input
            label="Task ID"
            value={task.id}
            error={errors.id}
            onChange={(event) => onChange({ ...task, id: event.target.value })}
          />
          <Input
            label="Title"
            value={task.title}
            error={errors.title}
            onChange={(event) =>
              onChange({ ...task, title: event.target.value })
            }
          />
        </div>

        <Textarea
          label="Instructions"
          value={task.instructions}
          error={errors.instructions}
          onChange={(event) =>
            onChange({ ...task, instructions: event.target.value })
          }
          rows={4}
        />

        <div className="grid gap-4 lg:grid-cols-2">
          <Textarea
            label="Labels"
            value={rawLabels}
            onChange={(event) => setRawLabels(event.target.value)}
            onBlur={(event) => commitLabels(event.target.value)}
            rows={4}
            placeholder="directory: src/components"
          />

          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium text-slate-400">
                Completion gates
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {COMPLETION_GATES.map((gate) => (
                  <Checkbox
                    key={gate}
                    containerClassName="rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs"
                    className="h-3.5 w-3.5 bg-slate-950"
                    label={gate}
                    checked={task.completionGates.includes(gate)}
                    onChange={() => toggleGate(gate)}
                  />
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-400">
                Depends on
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {dependencyOptions.length === 0 && (
                  <span className="text-xs text-slate-500">No other tasks</span>
                )}
                {dependencyOptions.map((candidate) => (
                  <Checkbox
                    key={candidate.id}
                    containerClassName="rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs"
                    className="h-3.5 w-3.5 bg-slate-950"
                    label={candidate.id}
                    checked={task.dependsOn.includes(candidate.id)}
                    onChange={() => toggleDependency(candidate.id)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={!canRemove}
            onClick={onRemove}
          >
            Drop task
          </Button>
        </div>
      </div>
    </Card>
  );
}
