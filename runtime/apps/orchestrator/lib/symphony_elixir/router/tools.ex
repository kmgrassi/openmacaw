defmodule SymphonyElixir.Router.Tools do
  @moduledoc """
  Runtime registry descriptors for platform-owned router tools.

  The platform API owns persistence and authorization for these database tools.
  Runtime registers the names and schemas so granted router agents can receive
  stable model-facing tool definitions.
  """

  @spec tool_specs() :: [map()]
  def tool_specs do
    [
      %{
        "name" => "routing_rule.list",
        "description" =>
          "List routing rules in the current workspace with primary model, floor, and fallback chain.",
        "inputSchema" => %{
          "type" => "object",
          "properties" => %{"limit" => %{"type" => "integer", "minimum" => 1, "maximum" => 200}}
        }
      },
      %{
        "name" => "routing_rule.read",
        "description" => "Read one routing rule by routingRuleId in the current workspace.",
        "inputSchema" => %{
          "type" => "object",
          "required" => ["routingRuleId"],
          "properties" => %{"routingRuleId" => %{"type" => "string"}}
        }
      },
      %{
        "name" => "routing_rule.update",
        "description" =>
          "Update a routing rule primary model and/or fallback chain. A non-empty reason is required. model_tier_floor is user-owned and cannot be changed.",
        "inputSchema" => %{
          "type" => "object",
          "required" => ["routingRuleId", "reason"],
          "properties" => %{
            "routingRuleId" => %{"type" => "string"},
            "provider" => %{"type" => "string"},
            "model" => %{"type" => "string"},
            "credentialRef" => credential_ref_schema(),
            "fallbacks" => %{
              "type" => "array",
              "items" => %{
                "type" => "object",
                "required" => ["provider", "model"],
                "properties" => %{
                  "provider" => %{"type" => "string"},
                  "model" => %{"type" => "string"},
                  "credentialRef" => credential_ref_schema()
                }
              }
            },
            "enabled" => %{"type" => "boolean"},
            "reason" => %{"type" => "string", "minLength" => 1}
          }
        }
      },
      %{
        "name" => "provider_failure.list",
        "description" => "List recent provider failures for the current workspace.",
        "inputSchema" => limit_schema(100)
      },
      %{
        "name" => "local_model.list",
        "description" =>
          "List active local runtime machines and advertised models in the current workspace.",
        "inputSchema" => %{"type" => "object", "properties" => %{}}
      },
      %{
        "name" => "provider_cutover.list",
        "description" => "List recent provider cutover audit rows for the current workspace.",
        "inputSchema" => limit_schema(100)
      }
    ]
  end

  @spec tool_spec(String.t()) :: map()
  def tool_spec(name) do
    Enum.find(tool_specs(), &(&1["name"] == name)) ||
      raise ArgumentError, "unknown router tool #{inspect(name)}"
  end

  defp credential_ref_schema do
    %{
      "type" => "object",
      "required" => ["type", "value"],
      "properties" => %{
        "type" => %{"type" => "string", "enum" => ["credential_id", "alias"]},
        "value" => %{"type" => "string"}
      }
    }
  end

  defp limit_schema(maximum) do
    %{
      "type" => "object",
      "properties" => %{"limit" => %{"type" => "integer", "minimum" => 1, "maximum" => maximum}}
    }
  end
end
