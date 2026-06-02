defmodule SymphonyElixir.OnboardingDefaultModelRoutesTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.ExecutionProfile

  @fixture_path Path.expand("../../priv/fixtures/onboarding_default_model_routes.json", __DIR__)

  describe "onboarding PR6 default model routing" do
    test "platform default provider/model pairs resolve to runtime runners" do
      fixture = @fixture_path |> File.read!() |> Jason.decode!()

      for route <- Map.fetch!(fixture, "routes") do
        assert {:ok, profile} =
                 ExecutionProfile.normalize_from_config(%{
                   "execution_profile" => %{
                     "role" => Map.fetch!(route, "role"),
                     "runner_kind" => Map.fetch!(route, "runner_kind"),
                     "provider" => Map.fetch!(route, "provider"),
                     "model" => Map.fetch!(route, "model")
                   }
                 }),
               """
               Onboarding default route failed to normalize:
               role=#{route["role"]} runner_kind=#{route["runner_kind"]} provider=#{route["provider"]} model=#{route["model"]}
               Update SymphonyElixir.ExecutionProfile if the platform PR6 default should be routable.
               """

        assert profile["runner_kind"] == Map.fetch!(route, "expected_runner_kind")
        assert profile["provider"] == Map.fetch!(route, "provider")
        assert profile["model"] == Map.fetch!(route, "model")

        assert {:ok, runner_module} = ExecutionProfile.runner_module(profile)
        assert inspect(runner_module) == Map.fetch!(route, "expected_runner_module")
      end
    end
  end
end
