defmodule SymphonyElixir.Time do
  @moduledoc """
  Shared UTC time and ISO8601 helpers.
  """

  @type truncate_unit :: :microsecond | :millisecond | :second

  @doc """
  Returns the current UTC datetime.
  """
  @spec now() :: DateTime.t()
  def now, do: DateTime.utc_now()

  @doc """
  Returns the current UTC datetime as an ISO8601 string.

  Pass `truncate: :second` or `truncate: :millisecond` to trim precision before
  formatting.
  """
  @spec now_iso8601(keyword()) :: String.t()
  def now_iso8601(opts \\ []) do
    now()
    |> to_iso8601(opts)
  end

  @doc """
  Parses an ISO8601 datetime string.

  Returns `nil` for nil, non-binary, or invalid inputs so callers that tolerate
  optional timestamps do not need to duplicate defensive parsing.
  """
  @spec parse_iso8601(term()) :: DateTime.t() | nil
  def parse_iso8601(nil), do: nil
  def parse_iso8601(%DateTime{} = datetime), do: datetime

  def parse_iso8601(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, datetime, _offset} -> datetime
      _ -> nil
    end
  end

  def parse_iso8601(_value), do: nil

  @doc """
  Converts supported time values to ISO8601 strings.

  Existing ISO8601 strings are passed through unchanged. Unsupported values
  return `nil`.
  """
  @spec to_iso8601(term(), keyword()) :: String.t() | nil
  def to_iso8601(value, opts \\ [])

  def to_iso8601(nil, _opts), do: nil

  def to_iso8601(%DateTime{} = datetime, opts) do
    datetime
    |> maybe_truncate(Keyword.get(opts, :truncate))
    |> DateTime.to_iso8601()
  end

  def to_iso8601(value, _opts) when is_binary(value), do: value
  def to_iso8601(_value, _opts), do: nil

  defp maybe_truncate(datetime, unit) when unit in [:microsecond, :millisecond, :second] do
    DateTime.truncate(datetime, unit)
  end

  defp maybe_truncate(datetime, _unit), do: datetime
end
