import { Button } from "../../ui/Button";
import { LEARNING_PROVIDER_WARNING_BODY } from "../../../lib/learning-provider-warning";

type LearningProviderChangeDialogProps = {
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function LearningProviderChangeDialog({
  saving,
  onCancel,
  onConfirm,
}: LearningProviderChangeDialogProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="learning-provider-warning-title"
    >
      <div className="w-full max-w-md rounded-lg border border-amber-500/30 bg-slate-950 p-5 shadow-xl">
        <h3
          id="learning-provider-warning-title"
          className="text-base font-semibold text-slate-100"
        >
          Change provider?
        </h3>
        <p className="mt-3 text-sm leading-6 text-slate-300">
          {LEARNING_PROVIDER_WARNING_BODY}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm} loading={saving}>
            Change provider
          </Button>
        </div>
      </div>
    </div>
  );
}
