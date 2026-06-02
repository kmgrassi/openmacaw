defmodule SymphonyElixir.Schema do
  @moduledoc """
  Dispatcher for runtime wire-boundary schema validation.

  Boundary modules should call `validate/2` immediately after JSON decoding and
  before passing payloads into domain logic. Each supported type maps to a
  schema module that returns a typed struct on success or an `Ecto.Changeset`
  with field-level errors on failure.
  """

  @type schema_type :: :wire_envelope | :execution_profile
  @type validation_error :: {:unsupported_schema_type, atom()} | Ecto.Changeset.t()

  @validators %{
    wire_envelope: SymphonyElixir.Schema.WireEnvelope,
    execution_profile: SymphonyElixir.Schema.ExecutionProfile
  }

  @spec validate(schema_type() | atom(), term()) ::
          {:ok, struct()} | {:error, validation_error()}
  def validate(type, attrs) when is_atom(type) do
    case Map.fetch(@validators, type) do
      {:ok, validator} -> validator.validate(attrs)
      :error -> {:error, {:unsupported_schema_type, type}}
    end
  end

  def validate(_type, _attrs), do: {:error, {:unsupported_schema_type, :unknown}}

  @spec supported_types() :: [schema_type()]
  def supported_types do
    Map.keys(@validators)
  end
end

defmodule SymphonyElixir.Schema.WireEnvelope do
  @moduledoc """
  Minimal shared envelope used to prove the schema dispatcher contract.

  More specific PRs should add dedicated schema modules for each wire type and
  register them in `SymphonyElixir.Schema`.
  """

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key false

  @type t :: %__MODULE__{
          type: String.t()
        }

  embedded_schema do
    field(:type, :string)
  end

  @spec validate(term()) :: {:ok, t()} | {:error, Ecto.Changeset.t()}
  def validate(attrs) when is_map(attrs) do
    %__MODULE__{}
    |> changeset(attrs)
    |> apply_action(:validate)
  end

  def validate(_attrs) do
    %__MODULE__{}
    |> change()
    |> add_error(:type, "must be provided in an object payload")
    |> apply_action(:validate)
  end

  @spec changeset(t(), map()) :: Ecto.Changeset.t()
  def changeset(schema, attrs) do
    schema
    |> cast(attrs, [:type], empty_values: [])
    |> validate_required([:type])
  end
end
