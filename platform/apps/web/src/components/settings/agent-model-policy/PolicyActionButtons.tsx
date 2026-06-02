import { Button } from "../../ui/Button";

type PolicyActionButtonsProps = {
  dirty: boolean;
  disableSave: boolean;
  saving: boolean;
  onReset: () => void;
  onSave: () => void;
};

export function PolicyActionButtons({
  dirty,
  disableSave,
  saving,
  onReset,
  onSave,
}: PolicyActionButtonsProps) {
  return (
    <div className="flex justify-end gap-2">
      {dirty && (
        <Button variant="ghost" size="sm" onClick={onReset}>
          Cancel
        </Button>
      )}
      <Button
        size="sm"
        disabled={disableSave}
        loading={saving}
        onClick={onSave}
      >
        Save
      </Button>
    </div>
  );
}
