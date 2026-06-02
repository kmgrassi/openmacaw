defmodule SymphonyElixir.Runner.Artifacts.Uploader do
  @moduledoc """
  Upload behaviour used by runtime artifact sinks.
  """

  @callback put_object(bucket :: String.t(), key :: String.t(), body :: binary(), opts :: keyword()) ::
              {:ok, map()} | {:error, term()}
end
