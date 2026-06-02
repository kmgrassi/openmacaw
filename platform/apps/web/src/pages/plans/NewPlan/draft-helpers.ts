import {
  normalizeDraft,
  type PlanDraft,
  type PlanTaskDraft,
} from "../../../api/plans";

export type TaskDraftErrors = Partial<Record<keyof PlanTaskDraft, string>>;

function nextTaskId(tasks: PlanTaskDraft[]) {
  const used = new Set(tasks.map((task) => task.id));
  for (let index = tasks.length + 1; index < tasks.length + 100; index += 1) {
    const id = `t-${String(index).padStart(2, "0")}`;
    if (!used.has(id)) return id;
  }
  return `t-${Date.now().toString(36)}`;
}

export function emptyTask(tasks: PlanTaskDraft[]): PlanTaskDraft {
  return {
    id: nextTaskId(tasks),
    title: "New task",
    instructions: "",
    labels: {},
    dependsOn: [],
    completionGates: [],
  };
}

export function labelsToText(labels: Record<string, string>) {
  return Object.entries(labels)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

export function textToLabels(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((acc, line) => {
      const [rawKey, ...rawValue] = line.split(":");
      const key = rawKey?.trim();
      const labelValue = rawValue.join(":").trim();
      if (key && labelValue) acc[key] = labelValue;
      return acc;
    }, {});
}

export function validateDraft(draft: PlanDraft): string | null {
  try {
    normalizeDraft(draft);
  } catch {
    return "Review the highlighted fields before approving this plan.";
  }

  const ids = new Set(draft.tasks.map((task) => task.id));
  const duplicateId = draft.tasks.find(
    (task, index) =>
      draft.tasks.findIndex((candidate) => candidate.id === task.id) !== index,
  );
  if (duplicateId) return `Task ID ${duplicateId.id} is duplicated.`;

  const missingDependency = draft.tasks
    .flatMap((task) =>
      task.dependsOn.map((dependency) => ({ taskId: task.id, dependency })),
    )
    .find(({ dependency }) => !ids.has(dependency));

  if (missingDependency) {
    return `${missingDependency.taskId} depends on unknown task ${missingDependency.dependency}.`;
  }

  return null;
}

export function taskErrors(task: PlanTaskDraft): TaskDraftErrors {
  return {
    id: /^t-[a-z0-9-]+$/.test(task.id)
      ? undefined
      : "Use t- followed by lowercase letters, numbers, or hyphens.",
    title: task.title.trim() ? undefined : "Title is required.",
    instructions: task.instructions.trim()
      ? undefined
      : "Instructions are required.",
  };
}
