import type { MutableRefObject } from "react";
import type { CredentialProvider } from "../../../../../../contracts/credentials";
import type { SavedCredential } from "../../../api/credentials";
import type { useCredentialMutations } from "../../../hooks/useServerStateQueries";
import { Button } from "../../ui/Button";
import { CredentialEditor } from "../CredentialEditor";

type CredentialMutations = ReturnType<typeof useCredentialMutations>;

type AddCredentialDialogProps = {
  open: boolean;
  agentId: string;
  workspaceId?: string | null;
  initialProvider: CredentialProvider;
  providerOptions?: CredentialProvider[];
  credentialMutations: CredentialMutations;
  skipNextReferenceSyncRef: MutableRefObject<boolean>;
  onSaved?: () => Promise<void> | void;
  onClose: () => void;
  onCredentialSaved: (credential: SavedCredential) => void;
  onOAuthConnected: () => Promise<void>;
  title?: string;
};

export function AddCredentialDialog({
  open,
  agentId,
  workspaceId,
  initialProvider,
  providerOptions,
  credentialMutations,
  skipNextReferenceSyncRef,
  onSaved,
  onClose,
  onCredentialSaved,
  onOAuthConnected,
  title = "Add Credential",
}: AddCredentialDialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-border bg-surface-raised p-4 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-credential-title"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h4
              id="add-credential-title"
              className="text-sm font-medium text-slate-300"
            >
              {title}
            </h4>
            <p className="mt-1 text-xs text-slate-500">
              Save a credential, then attach it to this agent.
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <CredentialEditor
          agentId={agentId}
          workspaceId={workspaceId}
          initialProvider={initialProvider}
          providerOptions={providerOptions}
          enabledFormats={["api_key", "oauth"]}
          onApiKeyCredential={async (credential) => {
            if (!workspaceId) return;
            skipNextReferenceSyncRef.current = true;
            const response = await credentialMutations.saveStored.mutateAsync({
              scope: { kind: "workspace", workspaceId },
              provider: credential.provider,
              apiKey: credential.secret,
            });
            onCredentialSaved(response.credential);
            onClose();
          }}
          onOAuthConnected={async () => {
            await onOAuthConnected();
            onClose();
          }}
          onSaved={onSaved}
        />
      </div>
    </div>
  );
}
