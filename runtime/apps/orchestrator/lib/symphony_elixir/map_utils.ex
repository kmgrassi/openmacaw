defmodule SymphonyElixir.MapUtils do
  @moduledoc """
  Small helpers for shared map and payload shaping.

  Keep this module limited to semantics that are truly common across callers.
  Domain-specific row and payload mapping should stay close to the domain code.
  """

  @doc """
  Puts `value` under `key` unless the value is absent.

  By default only `nil` is considered absent. Callers that also want to omit
  empty strings, lists, or maps can pass `empty_values: [...]`.
  """
  @spec put_present(map(), term(), term(), keyword()) :: map()
  def put_present(map, key, value, opts \\ []) when is_map(map) do
    empty_values = Keyword.get(opts, :empty_values, [nil])

    if value in empty_values do
      map
    else
      Map.put(map, key, value)
    end
  end

  @doc """
  Drops entries whose value is `nil`.
  """
  @spec drop_nil_values(map()) :: map()
  def drop_nil_values(map) when is_map(map) do
    Map.reject(map, fn {_key, value} -> is_nil(value) end)
  end

  @doc """
  Fetches a required key, checking the provided key and its atom/string variant.
  """
  @spec fetch_required(map(), atom() | String.t(), keyword()) :: {:ok, term()} | {:error, term()}
  def fetch_required(map, key, opts \\ []) when is_map(map) do
    empty_values = Keyword.get(opts, :empty_values, [nil, ""])

    case atom_or_string_get(map, key) do
      value ->
        if value in empty_values do
          {:error, {:missing_required, key}}
        else
          {:ok, value}
        end
    end
  end

  @doc """
  Converts common scalar values to strings for payload fields.
  """
  @spec stringify(term()) :: String.t() | nil
  def stringify(nil), do: nil
  def stringify(value) when is_binary(value), do: value
  def stringify(value) when is_atom(value), do: Atom.to_string(value)
  def stringify(value), do: inspect(value)

  @doc """
  Converts map-like values to maps.
  """
  @spec to_map(term()) :: map()
  def to_map(nil), do: %{}
  def to_map(value) when is_map(value), do: value
  def to_map(value) when is_list(value), do: map_from_list(value)
  def to_map(_value), do: %{}

  @doc """
  Gets a value from a map by checking the key and its atom/string variant.
  """
  @spec atom_or_string_get(map(), atom() | String.t()) :: term()
  def atom_or_string_get(map, key) when is_map(map) and is_atom(key) do
    fetch_variant(map, key, Atom.to_string(key))
  end

  def atom_or_string_get(map, key) when is_map(map) and is_binary(key) do
    fetch_variant(map, key, existing_atom(key))
  end

  @doc """
  Gets a trimmed string value from a map by checking the key and its atom/string variant.

  Empty strings normalize to `nil`.
  """
  @spec trimmed_string(map(), atom() | String.t()) :: String.t() | nil
  def trimmed_string(map, key) when is_map(map) do
    case atom_or_string_get(map, key) do
      value when is_binary(value) ->
        case String.trim(value) do
          "" -> nil
          trimmed -> trimmed
        end

      _ ->
        nil
    end
  end

  defp fetch_variant(map, key, alternate_key) do
    case Map.fetch(map, key) do
      {:ok, nil} -> fetch_alternate(map, alternate_key)
      {:ok, value} -> value
      :error -> fetch_alternate(map, alternate_key)
    end
  end

  defp fetch_alternate(_map, nil), do: nil
  defp fetch_alternate(map, key), do: Map.get(map, key)

  defp existing_atom(value) do
    String.to_existing_atom(value)
  rescue
    ArgumentError -> nil
  end

  defp map_from_list(value) do
    Map.new(value)
  rescue
    ArgumentError -> %{}
  end
end
