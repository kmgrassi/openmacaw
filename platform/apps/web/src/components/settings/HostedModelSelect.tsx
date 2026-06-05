import { useMemo } from "react";

import { useModelCatalogQueries } from "../../hooks/useServerStateQueries";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";

type HostedModelSelectProps = {
  label: string;
  value: string;
  workspaceId?: string | null;
  provider?: string | null;
  disabled?: boolean;
  allowCustomWhenEmpty?: boolean;
  customPlaceholder?: string;
  onChange: (value: string) => void;
};

export function HostedModelSelect({
  label,
  value,
  workspaceId,
  provider,
  disabled,
  allowCustomWhenEmpty,
  customPlaceholder,
  onChange,
}: HostedModelSelectProps) {
  const { catalog } = useModelCatalogQueries({
    workspaceId,
    fallbackMode: "all",
  });
  const options = useMemo(() => {
    const models = catalog.data?.models ?? [];
    const filtered = provider
      ? models.filter((model) => model.provider === provider)
      : models;
    const next = filtered.map((model) => ({
      value: model.id,
      label: `${model.name} (${model.providerName ?? model.provider})`,
    }));

    if (value && !next.some((option) => option.value === value)) {
      next.unshift({ value, label: `${value} (current)` });
    }
    if (!value) {
      next.unshift({ value: "", label: "Select a model..." });
    }
    if (next.length === 0 && !allowCustomWhenEmpty) {
      next.push({ value: "", label: "No models available" });
    }
    return next;
  }, [allowCustomWhenEmpty, catalog.data?.models, provider, value]);

  if (allowCustomWhenEmpty && options.length === 0) {
    return (
      <Input
        label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={customPlaceholder}
        disabled={disabled || catalog.isLoading}
      />
    );
  }

  return (
    <Select
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      options={options}
      disabled={disabled || catalog.isLoading}
    />
  );
}
