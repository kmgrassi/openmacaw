package openai_compatible

import "testing"

func TestDecodeInputParsesOptionalGrantProvenance(t *testing.T) {
	req, err := decodeInput([]byte(`{
		"messages":[{"role":"user","content":"run"}],
		"tool_definitions":[{
			"name":"shell.exec",
			"parameters_schema":{"type":"object"},
			"execution_kind":"helper",
			"grant_provenance":{
				"agent_tool_grant_id":"grant_123",
				"source":"manual",
				"source_tool_template_id":"template_coding",
				"reason":"enabled by user",
				"created_by_user_id":"user_123"
			}
		}]
	}`))
	if err != nil {
		t.Fatalf("decodeInput() error = %v", err)
	}
	if len(req.ToolDefinitions) != 1 {
		t.Fatalf("tool definitions = %#v, want one", req.ToolDefinitions)
	}
	got := req.ToolDefinitions[0].GrantProvenance
	if got == nil {
		t.Fatal("grant provenance = nil")
	}
	if got.AgentToolGrantID != "grant_123" || got.Source != "manual" || got.SourceToolTemplateID != "template_coding" || got.Reason != "enabled by user" || got.CreatedByUserID != "user_123" {
		t.Fatalf("grant provenance = %#v", got)
	}
}

func TestDecodeInputPreservesScheduledMessageMetadata(t *testing.T) {
	req, err := decodeInput([]byte(`{
		"metadata":{"relay":"local"},
		"messages":[{
			"role":"user",
			"content":"scheduled instruction",
			"metadata":{"source":"scheduled_task","kind":"scheduled_agent_message"}
		}]
	}`))
	if err != nil {
		t.Fatalf("decodeInput() error = %v", err)
	}
	if req.Metadata["relay"] != "local" {
		t.Fatalf("request metadata = %#v", req.Metadata)
	}
	if len(req.Messages) != 1 {
		t.Fatalf("messages = %#v, want one", req.Messages)
	}
	if req.Messages[0].Metadata["source"] != "scheduled_task" || req.Messages[0].Metadata["kind"] != "scheduled_agent_message" {
		t.Fatalf("message metadata = %#v", req.Messages[0].Metadata)
	}
}
