defmodule SymphonyElixir.LocalModelSmoke do
  @moduledoc """
  Manual smoke harness for OpenAI-compatible local models.

  This module intentionally exercises the runtime provider normalization layer
  with an Ollama/vLLM/LM Studio-style endpoint. It is used by the PR8 local
  smoke flow to verify that a local Qwen response becomes the normalized event
  shape consumed at the runtime/platform boundary.
  """

  alias SymphonyElixir.Provider.OpenAICompatible

  @default_base_url "http://127.0.0.1:11434/v1"
  @default_model "qwen2.5-coder:latest"
  @default_api_key "ollama"
  @default_prompt "Reply with a short sentence confirming that the local Qwen smoke test completed."

  @type config :: %{
          required(:base_url) => String.t(),
          required(:model) => String.t(),
          required(:api_key) => String.t(),
          required(:prompt) => String.t(),
          optional(:req_options) => keyword()
        }

  @type summary :: %{
          required(:provider) => String.t(),
          required(:model) => String.t(),
          required(:output_text) => String.t(),
          required(:normalized_events) => [String.t()],
          required(:usage) => map()
        }

  @spec default_config_from_env() :: config()
  def default_config_from_env do
    %{
      base_url:
        env("SYMPHONY_LOCAL_MODEL_BASE_URL") ||
          env("OLLAMA_OPENAI_BASE_URL") ||
          ollama_openai_base_url(env("OLLAMA_BASE_URL")) ||
          @default_base_url,
      model: env("SYMPHONY_LOCAL_MODEL_NAME") || env("OLLAMA_MODEL") || @default_model,
      api_key: env("SYMPHONY_LOCAL_MODEL_API_KEY") || env("OLLAMA_API_KEY") || @default_api_key,
      prompt: env("SYMPHONY_LOCAL_MODEL_PROMPT") || @default_prompt
    }
  end

  @spec run(keyword()) :: {:ok, summary()} | {:error, term()}
  def run(opts \\ []) when is_list(opts) do
    config =
      default_config_from_env()
      |> Map.merge(Map.new(Keyword.get(opts, :config, %{})))
      |> maybe_put_req_options(Keyword.get(opts, :req_options))

    with :ok <- validate_config(config),
         {:ok, result} <- call_provider(config),
         {:ok, summary} <- summarize_result(result) do
      {:ok, summary}
    end
  end

  @spec normalized_event_names([map()]) :: [String.t()]
  def normalized_event_names(events) when is_list(events) do
    Enum.flat_map(events, fn
      %{event: :notification, payload: %{"method" => "provider/message.delta"}} -> ["message.delta"]
      %{event: :notification, payload: %{"method" => method}} when is_binary(method) -> [method]
      %{event: :turn_completed} -> ["run.completed"]
      %{event: :turn_failed} -> ["run.failed"]
      %{event: event} when is_atom(event) -> [Atom.to_string(event)]
      %{"type" => type} when is_binary(type) -> [type]
      _event -> []
    end)
  end

  def normalized_event_names(_events), do: []

  @spec ollama_openai_base_url(String.t() | nil) :: String.t() | nil
  def ollama_openai_base_url(nil), do: nil

  def ollama_openai_base_url(base_url) when is_binary(base_url) do
    base_url = String.trim_trailing(base_url, "/")

    if String.ends_with?(base_url, "/v1") do
      base_url
    else
      base_url <> "/v1"
    end
  end

  defp maybe_put_req_options(config, nil), do: config
  defp maybe_put_req_options(config, req_options), do: Map.put(config, :req_options, req_options)

  defp validate_config(%{base_url: base_url, model: model, api_key: api_key, prompt: prompt})
       when is_binary(base_url) and is_binary(model) and is_binary(api_key) and is_binary(prompt) do
    cond do
      String.trim(base_url) == "" -> {:error, {:missing_requirement, :base_url}}
      String.trim(model) == "" -> {:error, {:missing_requirement, :model}}
      String.trim(api_key) == "" -> {:error, {:missing_requirement, :api_key}}
      String.trim(prompt) == "" -> {:error, {:missing_requirement, :prompt}}
      true -> :ok
    end
  end

  defp validate_config(_config), do: {:error, :invalid_local_model_smoke_config}

  defp call_provider(config) do
    profile = %{
      "base_url" => config.base_url,
      "model" => config.model,
      "api_key" => config.api_key,
      "temperature" => 0,
      "max_tokens" => 128
    }

    messages = [
      %{
        role: "system",
        content: "You are running a local model smoke test. Keep the answer concise."
      },
      %{role: "user", content: config.prompt}
    ]

    OpenAICompatible.start_turn(profile, messages, [], req_options: Map.get(config, :req_options, []))
  end

  defp summarize_result(result) do
    output_text = result |> Map.get(:output_text, "") |> to_string() |> String.trim()
    normalized_events = normalized_event_names(Map.get(result, :events, []))

    cond do
      output_text == "" ->
        {:error, {:local_model_smoke_failed, :empty_output}}

      "message.delta" not in normalized_events ->
        {:error, {:local_model_smoke_failed, :missing_message_delta_event}}

      "run.completed" not in normalized_events ->
        {:error, {:local_model_smoke_failed, :missing_run_completed_event}}

      true ->
        {:ok,
         %{
           provider: Map.get(result, :provider),
           model: Map.get(result, :model),
           output_text: output_text,
           normalized_events: normalized_events,
           usage: Map.get(result, :usage, %{})
         }}
    end
  end

  defp env(key) do
    case System.get_env(key) do
      nil -> nil
      value -> value |> String.trim() |> blank_to_nil()
    end
  end

  defp blank_to_nil(""), do: nil
  defp blank_to_nil(value), do: value
end
