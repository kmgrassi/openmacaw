defmodule SymphonyElixir.Planner.DatabaseTools.Arguments do
  @moduledoc false

  @spec normalize_arguments(term()) :: {:ok, map()} | {:error, :invalid_arguments}
  def normalize_arguments(arguments) when is_map(arguments) do
    {:ok, Map.new(arguments, fn {key, value} -> {to_string(key), value} end)}
  end

  def normalize_arguments(_arguments), do: {:error, :invalid_arguments}

  @spec required_string(map(), String.t()) :: {:ok, String.t()} | {:error, {:missing_argument, String.t()}}
  def required_string(args, key) do
    case Map.get(args, key) do
      value when is_binary(value) ->
        case String.trim(value) do
          "" -> {:error, {:missing_argument, key}}
          trimmed -> {:ok, trimmed}
        end

      _ ->
        {:error, {:missing_argument, key}}
    end
  end

  @spec workspace_id(map(), keyword()) :: {:ok, String.t()} | {:error, {:missing_argument, String.t()}}
  def workspace_id(args, opts) do
    case Keyword.get(opts, :workspace_id) do
      value when is_binary(value) and value != "" -> {:ok, value}
      _ -> required_string(args, "workspace_id")
    end
  end

  @spec require_present(map(), String.t()) :: :ok | {:error, {:missing_argument, String.t()}}
  def require_present(args, key) do
    if Map.has_key?(args, key), do: :ok, else: {:error, {:missing_argument, key}}
  end

  @spec nullable_iso8601(map(), String.t()) :: {:ok, String.t() | nil} | {:error, tuple()}
  def nullable_iso8601(args, key) do
    case Map.get(args, key) do
      nil ->
        {:ok, nil}

      value when is_binary(value) ->
        case DateTime.from_iso8601(value) do
          {:ok, datetime, _offset} -> {:ok, DateTime.to_iso8601(datetime)}
          {:error, _reason} -> {:error, {:invalid_argument, key, "must be ISO-8601 or null"}}
        end

      _ ->
        {:error, {:invalid_argument, key, "must be ISO-8601 or null"}}
    end
  end

  @spec optional_positive_integer(map(), String.t()) :: {:ok, pos_integer() | nil} | {:error, tuple()}
  def optional_positive_integer(args, key) do
    case Map.get(args, key) do
      nil -> {:ok, nil}
      value when is_integer(value) and value > 0 -> {:ok, value}
      _ -> {:error, {:invalid_argument, key, "must be a positive integer"}}
    end
  end

  @spec optional_string(map(), String.t()) :: {:ok, String.t() | nil} | {:error, tuple()}
  def optional_string(args, key) do
    case optional_value(args, key) do
      nil -> {:ok, nil}
      value when is_binary(value) -> {:ok, value}
      _ -> {:error, {:invalid_argument, key, "must be a string"}}
    end
  end

  @spec with_if_updated_at(keyword(), map()) :: keyword()
  def with_if_updated_at(opts, args) do
    case if_updated_at(args) do
      nil -> opts
      value -> Keyword.put(opts, :if_updated_at, value)
    end
  end

  @spec if_updated_at(map()) :: String.t() | nil
  def if_updated_at(args) do
    case optional_value(args, "if_updated_at") do
      value when is_binary(value) -> value
      _ -> nil
    end
  end

  @spec if_updated_at_opt(keyword() | map() | term()) :: String.t() | nil
  def if_updated_at_opt(opts) when is_list(opts) do
    case Keyword.get(opts, :if_updated_at) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  def if_updated_at_opt(_opts), do: nil

  @spec maybe_put_updated_at_guard(map(), String.t() | nil) :: map()
  def maybe_put_updated_at_guard(query, value) when is_binary(value) and value != "" do
    Map.put(query, "updated_at", "eq.#{value}")
  end

  def maybe_put_updated_at_guard(query, _value), do: query

  @spec put_optional(map(), map(), String.t()) :: map()
  def put_optional(payload, args, key) do
    if Map.has_key?(args, key) do
      Map.put(payload, key, Map.get(args, key))
    else
      payload
    end
  end

  @spec put_optional_non_blank(map(), map(), String.t()) :: map()
  def put_optional_non_blank(payload, args, key) do
    case optional_value(args, key) do
      nil -> payload
      value -> Map.put(payload, key, value)
    end
  end

  @spec maybe_put_optional(map(), String.t(), term()) :: map()
  def maybe_put_optional(payload, _key, nil), do: payload
  def maybe_put_optional(payload, key, value), do: Map.put(payload, key, value)

  @spec optional_value(map(), String.t()) :: term()
  def optional_value(args, key) do
    case Map.get(args, key) do
      value when value in ["", nil] -> nil
      value -> value
    end
  end

  @spec option_value(keyword() | map() | term(), atom()) :: term()
  def option_value(opts, key) when is_list(opts) do
    case Keyword.get(opts, key) do
      value when value in ["", nil] -> nil
      value -> value
    end
  end

  def option_value(opts, key) when is_map(opts) do
    case Map.get(opts, key) || Map.get(opts, Atom.to_string(key)) do
      value when value in ["", nil] -> nil
      value -> value
    end
  end

  def option_value(_opts, _key), do: nil
end
