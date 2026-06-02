defmodule SymphonyElixir.ExecutionAdapter.Error do
  @moduledoc """
  Structured execution adapter error returned before provider-specific work starts.
  """

  @type code ::
          :missing_adapter_config
          | :unsupported_execution_mode
          | :missing_resource_grant_metadata
          | :unavailable_capacity
          | :unsupported_execution_target

  @type t :: %__MODULE__{
          code: code(),
          message: String.t(),
          details: map()
        }

  defstruct [:code, :message, details: %{}]

  @spec new(code(), String.t(), map()) :: t()
  def new(code, message, details \\ %{}) when is_atom(code) and is_binary(message) and is_map(details) do
    %__MODULE__{code: code, message: message, details: details}
  end

  @spec to_map(t()) :: map()
  def to_map(%__MODULE__{} = error) do
    %{
      "code" => Atom.to_string(error.code),
      "message" => error.message,
      "details" => error.details
    }
  end
end
