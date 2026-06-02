package main

import (
	"flag"
	"fmt"
	"os"
)

func cmdStatus(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath, "path to runtime.toml")
	_ = fs.Parse(args)

	cfg, err := loadRuntimeConfig(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "status: config unavailable: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("local-runtime-helper status")
	fmt.Printf("Config: %s\n", cfg.Path)
	if cfg.Machine.DisplayName != "" {
		fmt.Printf("Machine: %s\n", cfg.Machine.DisplayName)
	} else {
		fmt.Println("Machine: unnamed")
	}
	if cfg.Cloud.Endpoint != "" {
		fmt.Printf("Cloud: %s\n", endpointHost(cfg.Cloud.Endpoint))
	} else {
		fmt.Println("Cloud: missing endpoint")
	}
	fmt.Printf("Token: %s\n", redactToken(cfg.Cloud.Token))
	if len(cfg.Runners) == 0 {
		fmt.Println("Runners: none configured")
		return
	}
	fmt.Println("Runners:")
	for _, kind := range sortedRunnerKinds(cfg.Runners) {
		runner := cfg.Runners[kind]
		line := fmt.Sprintf("  - %s", kind)
		if runner.Endpoint != "" {
			line += fmt.Sprintf(" (%s)", endpointHost(runner.Endpoint))
		}
		if runner.Model != "" {
			line += fmt.Sprintf(" model=%s", runner.Model)
		}
		fmt.Println(line)
	}
}
