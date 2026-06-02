defmodule SymphonyElixir.Schema.LocalRelayRegister do
  @moduledoc """
  Validates local runtime helper registration frames at the websocket boundary.
  """

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key false
  embedded_schema do
    field(:workspace_id, :string)
    field(:machine_id, :string)
    field(:helper_version, :string)
    field(:runner_kinds, {:array, :string}, default: [])
    field(:metadata, :map, default: %{})

    embeds_many :runners, Runner, primary_key: false, on_replace: :delete do
      field(:runner_kind, :string)
      field(:provider, :string)
      field(:model, :string)
      field(:capabilities, :map, default: %{})
    end
  end

  @type runner :: %{
          required(:runner_kind) => String.t(),
          optional(:provider) => String.t(),
          optional(:model) => String.t(),
          optional(:capabilities) => map()
        }

  @type t :: %__MODULE__{
          workspace_id: String.t(),
          machine_id: String.t(),
          helper_version: String.t() | nil,
          runner_kinds: [String.t()],
          runners: [struct()],
          metadata: map()
        }

  @doc """
  Validate a decoded register frame and return a typed registration struct.
  """
  @spec validate(map()) :: {:ok, t()} | {:error, Ecto.Changeset.t()}
  def validate(attrs) when is_map(attrs) do
    %__MODULE__{}
    |> cast(attrs, [:workspace_id, :machine_id, :helper_version, :runner_kinds, :metadata])
    |> validate_required([:workspace_id, :machine_id])
    |> validate_non_empty_string(:workspace_id)
    |> validate_non_empty_string(:machine_id)
    |> validate_optional_non_empty_string(:helper_version)
    |> validate_string_list(:runner_kinds)
    |> update_change(:runner_kinds, &Enum.uniq/1)
    |> cast_embed(:runners, with: &runner_changeset/2)
    |> apply_action(:validate)
  end

  @doc """
  Convert a valid registration struct into the map expected by Presence.
  """
  @spec to_presence_registration(t(), map()) :: map()
  def to_presence_registration(%__MODULE__{} = registration, attrs \\ %{}) do
    %{
      workspace_id: registration.workspace_id,
      machine_id: registration.machine_id,
      runner_kinds: registration.runner_kinds,
      runners: Enum.map(registration.runners, &runner_to_map/1),
      metadata: registration.metadata
    }
    |> Map.merge(attrs)
  end

  @doc """
  Render changeset errors into a compact protocol error message.
  """
  @spec error_message(Ecto.Changeset.t()) :: String.t()
  def error_message(%Ecto.Changeset{} = changeset) do
    changeset
    |> traverse_errors(fn {message, opts} ->
      Enum.reduce(opts, message, fn {key, value}, acc ->
        String.replace(acc, "%{#{key}}", inspect(value))
      end)
    end)
    |> flatten_errors()
    |> Enum.join(", ")
  end

  defp runner_changeset(runner, attrs) do
    runner
    |> cast(attrs, [:runner_kind, :provider, :model, :capabilities])
    |> validate_required([:runner_kind])
    |> validate_non_empty_string(:runner_kind)
    |> validate_optional_non_empty_string(:provider)
    |> validate_optional_non_empty_string(:model)
  end

  defp validate_string_list(changeset, field) do
    validate_change(changeset, field, fn ^field, values ->
      case Enum.find(values, &(not valid_string?(&1))) do
        nil -> []
        _invalid -> [{field, "must contain only non-empty strings"}]
      end
    end)
  end

  defp validate_non_empty_string(changeset, field) do
    validate_change(changeset, field, fn ^field, value ->
      if valid_string?(value), do: [], else: [{field, "can't be blank"}]
    end)
  end

  defp validate_optional_non_empty_string(changeset, field) do
    validate_change(changeset, field, fn ^field, value ->
      if is_nil(value) or valid_string?(value), do: [], else: [{field, "can't be blank"}]
    end)
  end

  defp valid_string?(value), do: is_binary(value) and String.trim(value) != ""

  defp runner_to_map(runner) do
    %{
      runner_kind: runner.runner_kind,
      capabilities: runner.capabilities
    }
    |> maybe_put(:provider, runner.provider)
    |> maybe_put(:model, runner.model)
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp flatten_errors(errors) when is_map(errors) do
    Enum.flat_map(errors, fn
      {field, nested} when is_map(nested) ->
        Enum.map(flatten_errors(nested), &"#{field}: #{&1}")

      {field, nested} when is_list(nested) ->
        if Enum.all?(nested, &is_binary/1) do
          Enum.map(nested, &"#{field} #{&1}")
        else
          nested
          |> Enum.flat_map(&flatten_errors/1)
          |> Enum.map(&"#{field}: #{&1}")
        end
    end)
  end
end
