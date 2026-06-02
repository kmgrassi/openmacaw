defmodule SymphonyElixir.Provider do
  @moduledoc """
  Behavior for model provider adapters.

  Provider adapters own upstream protocol details and return provider-neutral
  turn results that role runners can consume without depending on one model API.
  """

  @type message :: %{required(String.t()) => term()} | %{required(atom()) => term()}
  @type tool :: map()
  @type profile :: map()

  @type tool_call :: %{
          required(:id) => String.t() | nil,
          required(:name) => String.t() | nil,
          required(:arguments) => map() | String.t()
        }

  @type event :: %{
          required(:event) => atom(),
          required(:timestamp) => DateTime.t(),
          optional(:payload) => map(),
          optional(:usage) => map(),
          optional(:metadata) => map()
        }

  @type turn_result :: %{
          required(:provider) => String.t(),
          required(:model) => String.t(),
          optional(:id) => String.t(),
          optional(:output_text) => String.t(),
          optional(:tool_calls) => [tool_call()],
          optional(:usage) => map(),
          optional(:finish_reason) => String.t(),
          optional(:events) => [event()],
          optional(:raw) => map()
        }

  @callback start_turn(profile(), [message()], [tool()], keyword()) ::
              {:ok, turn_result()} | {:error, {:retryable | :fatal, map()}}
end
