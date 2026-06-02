package relay

import "testing"

func TestIsRelayAckFrameRecognizesRuntimeHeartbeatAck(t *testing.T) {
	raw := []byte(`{"type":"heartbeat_ack","protocol":1,"server_ts":1778848521827}`)

	if !isRelayAckFrame(raw) {
		t.Fatal("expected runtime heartbeat ack to be skipped by the relay read loop")
	}
}

func TestIsRelayAckFrameRejectsDispatchFrames(t *testing.T) {
	raw := []byte(`{"type":"dispatch","schema_version":"1","correlation_id":"run-1","runner_kind":"openai_compatible"}`)

	if isRelayAckFrame(raw) {
		t.Fatal("dispatch frames must still be decoded and delivered")
	}
}
