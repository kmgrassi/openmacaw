import { Alert } from "./ui/Alert";
import { Button } from "./ui/Button";

type ApprovalRequiredNoticeProps = {
  message?: string | null;
  onConfigure?: () => void;
};

export function isApprovalRequiredText(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return false;
  return (
    normalized.includes("approval_required") ||
    normalized.includes("approval required")
  );
}

export function ApprovalRequiredNotice({
  message,
  onConfigure,
}: ApprovalRequiredNoticeProps) {
  return (
    <Alert
      tone="warning"
      title="Approval required"
      detail={message}
      actions={
        onConfigure ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="shrink-0 border-amber-700/60 text-amber-100 hover:bg-amber-900/35"
            onClick={onConfigure}
          >
            Review settings
          </Button>
        ) : null
      }
    >
      The local coding runner stopped before running a shell command or applying
      a patch because this workspace does not have persisted approval review
      yet.
    </Alert>
  );
}
