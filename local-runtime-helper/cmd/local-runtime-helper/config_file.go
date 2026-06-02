package main

import (
	"bufio"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const defaultConfigPath = "~/.config/harper/runtime.toml"

type runtimeConfig struct {
	Path    string
	Machine struct {
		DisplayName string
	}
	Cloud struct {
		Endpoint string
		Token    string
	}
	Runners map[string]runnerConfig
}

type runnerConfig struct {
	Kind     string
	Endpoint string
	APIKey   string
	Model    string
	Fields   map[string]string
}

func expandedConfigPath(path string) (string, error) {
	if path == "" {
		path = defaultConfigPath
	}
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, strings.TrimPrefix(path, "~/")), nil
	}
	return filepath.Abs(path)
}

func loadRuntimeConfig(path string) (runtimeConfig, error) {
	resolved, err := expandedConfigPath(path)
	if err != nil {
		return runtimeConfig{}, err
	}

	f, err := os.Open(resolved)
	if err != nil {
		return runtimeConfig{Path: resolved}, err
	}
	defer f.Close()

	cfg := runtimeConfig{Path: resolved, Runners: map[string]runnerConfig{}}
	section := ""
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := stripComment(strings.TrimSpace(scanner.Text()))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(line, "["), "]"))
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return cfg, fmt.Errorf("invalid config line %q: expected key = value", line)
		}
		key = strings.TrimSpace(key)
		value = parseTomlString(strings.TrimSpace(value))
		switch {
		case section == "machine" && key == "display_name":
			cfg.Machine.DisplayName = value
		case section == "cloud" && key == "endpoint":
			cfg.Cloud.Endpoint = value
		case section == "cloud" && key == "token":
			cfg.Cloud.Token = value
		case strings.HasPrefix(section, "runner."):
			kind := strings.TrimPrefix(section, "runner.")
			runner := cfg.Runners[kind]
			if runner.Fields == nil {
				runner.Fields = map[string]string{}
			}
			runner.Kind = kind
			runner.Fields[key] = value
			switch key {
			case "endpoint":
				runner.Endpoint = value
			case "api_key":
				runner.APIKey = value
			case "model":
				runner.Model = value
			}
			cfg.Runners[kind] = runner
		}
	}
	if err := scanner.Err(); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func stripComment(line string) string {
	inQuote := false
	escaped := false
	for i, r := range line {
		switch {
		case escaped:
			escaped = false
		case r == '\\':
			escaped = true
		case r == '"':
			inQuote = !inQuote
		case r == '#' && !inQuote:
			return strings.TrimSpace(line[:i])
		}
	}
	return line
}

func parseTomlString(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
		return strings.ReplaceAll(strings.Trim(value, `"`), `\"`, `"`)
	}
	return value
}

func sortedRunnerKinds(runners map[string]runnerConfig) []string {
	kinds := make([]string, 0, len(runners))
	for kind := range runners {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	return kinds
}

func endpointHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	return u.Host
}

func redactToken(token string) string {
	if token == "" {
		return "missing"
	}
	if len(token) <= 8 {
		return "present"
	}
	return token[:4] + "..." + token[len(token)-4:]
}

func validationErrors(cfg runtimeConfig) []error {
	var errs []error
	if cfg.Cloud.Endpoint == "" {
		errs = append(errs, errors.New("cloud endpoint is missing"))
	}
	if cfg.Cloud.Token == "" {
		errs = append(errs, errors.New("cloud token is missing"))
	}
	for _, kind := range sortedRunnerKinds(cfg.Runners) {
		runner := cfg.Runners[kind]
		if runner.Endpoint == "" {
			errs = append(errs, fmt.Errorf("runner.%s endpoint is missing", kind))
		}
		if kind == "openai_compatible" && runner.Model == "" {
			errs = append(errs, errors.New("runner.openai_compatible model is missing"))
		}
	}
	return errs
}
