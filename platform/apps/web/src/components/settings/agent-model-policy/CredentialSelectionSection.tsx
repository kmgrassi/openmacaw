import { Alert } from "../../ui/Alert";
import { Select } from "../../ui/Select";

type CredentialOption = {
  value: string;
  label: string;
};

type CredentialSelectionSectionProps = {
  localCodingSelected: boolean;
  selectedProvider: string | null;
  selectedCredentialRef: string;
  selectedCredentialOptions: CredentialOption[];
  credentialSelectionRequired: boolean;
  credentialProviderLabel: string;
  onCredentialRefChange: (value: string) => void;
};

export function CredentialSelectionSection({
  localCodingSelected,
  selectedProvider,
  selectedCredentialRef,
  selectedCredentialOptions,
  credentialSelectionRequired,
  credentialProviderLabel,
  onCredentialRefChange,
}: CredentialSelectionSectionProps) {
  if (localCodingSelected || !selectedProvider) {
    return null;
  }

  if (credentialSelectionRequired) {
    return (
      <Select
        label="Credential"
        value={selectedCredentialRef}
        onChange={(event) => onCredentialRefChange(event.target.value)}
        options={[
          {
            value: "",
            label: `Select a ${credentialProviderLabel} credential...`,
          },
          ...selectedCredentialOptions,
        ]}
        error={
          selectedCredentialRef
            ? undefined
            : "Choose which stored credential this model should use."
        }
      />
    );
  }

  if (selectedCredentialOptions.length === 1) {
    return (
      <p className="text-xs text-slate-500">
        This model will use{" "}
        {
          selectedCredentialOptions.find(
            (option) => option.value === selectedCredentialRef,
          )?.label
        }
        .
      </p>
    );
  }

  if (selectedCredentialOptions.length === 0) {
    return (
      <Alert tone="warning" compact>
        Add a {credentialProviderLabel} credential in settings before saving
        this cloud model.
      </Alert>
    );
  }

  return null;
}
