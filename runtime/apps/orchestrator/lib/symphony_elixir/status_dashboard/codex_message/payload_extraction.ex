defmodule SymphonyElixir.StatusDashboard.CodexMessage.PayloadExtraction do
  @moduledoc false

  @spec unwrap_payload(term()) :: term()
  def unwrap_payload(%{} = message) do
    cond do
      is_binary(map_value(message, ["method", :method])) -> message
      is_binary(map_value(message, ["session_id", :session_id])) -> message
      is_binary(map_value(message, ["reason", :reason])) -> message
      true -> map_value(message, ["payload", :payload]) || message
    end
  end

  def unwrap_payload(message), do: message

  @spec extract_first_path(term(), [[term()]]) :: term() | nil
  def extract_first_path(payload, paths) do
    Enum.find_value(paths, fn path ->
      map_path(payload, path)
    end)
  end

  @spec map_path(term(), [term()]) :: term() | nil
  def map_path(data, [key | rest]) when is_map(data) do
    case fetch_map_key(data, key) do
      {:ok, value} when rest == [] -> value
      {:ok, value} -> map_path(value, rest)
      :error -> nil
    end
  end

  def map_path(_data, _path), do: nil

  @spec map_value(term(), [term()]) :: term() | nil
  def map_value(map, keys) when is_map(map) and is_list(keys) do
    Enum.find_value(keys, &Map.get(map, &1))
  end

  def map_value(_map, _keys), do: nil

  defp fetch_map_key(map, key) when is_map(map) do
    case Map.fetch(map, key) do
      {:ok, value} ->
        {:ok, value}

      :error ->
        alternate = alternate_key(key)

        if alternate == key do
          :error
        else
          Map.fetch(map, alternate)
        end
    end
  end

  defp alternate_key(key) when is_binary(key) do
    String.to_existing_atom(key)
  rescue
    ArgumentError -> key
  end

  defp alternate_key(key) when is_atom(key), do: Atom.to_string(key)
  defp alternate_key(key), do: key
end
