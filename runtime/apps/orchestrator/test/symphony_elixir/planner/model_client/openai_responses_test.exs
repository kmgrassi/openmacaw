defmodule SymphonyElixir.Planner.ModelClient.OpenAIResponsesTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Planner.ModelClient.OpenAIResponses

  describe "api_key resolution via ping/1" do
    setup do
      previous_openai_api_key = System.get_env("OPENAI_API_KEY")
      System.delete_env("OPENAI_API_KEY")

      on_exit(fn ->
        restore_env("OPENAI_API_KEY", previous_openai_api_key)
      end)

      :ok
    end

    test "resolves api_key from launcher-resolved credentials map when api_key is absent" do
      config = %{"credentials" => %{"OPENAI_API_KEY" => "sk-test"}}

      assert :ok = OpenAIResponses.ping(config)
    end

    test "prefers explicit api_key over credentials map" do
      config = %{
        "api_key" => "sk-explicit",
        "credentials" => %{"OPENAI_API_KEY" => "sk-from-credentials"}
      }

      assert :ok = OpenAIResponses.ping(config)
    end

    test "accepts atom-keyed credentials maps" do
      config = %{credentials: %{:OPENAI_API_KEY => "sk-atom"}}

      assert :ok = OpenAIResponses.ping(config)
    end

    test "falls back to OPENAI_API_KEY env var when neither api_key nor credentials are set" do
      System.put_env("OPENAI_API_KEY", "sk-env")

      assert :ok = OpenAIResponses.ping(%{})
    end

    test "returns :missing_openai_api_key when no source has a value" do
      assert {:error, :missing_openai_api_key} = OpenAIResponses.ping(%{})
    end

    test "returns :missing_openai_api_key when credentials map lacks OPENAI_API_KEY" do
      config = %{"credentials" => %{"LINEAR_API_KEY" => "lin_api_xyz"}}

      assert {:error, :missing_openai_api_key} = OpenAIResponses.ping(config)
    end
  end
end
