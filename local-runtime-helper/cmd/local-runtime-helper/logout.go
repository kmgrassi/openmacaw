package main

import (
	"flag"
	"fmt"
	"os"
)

func cmdLogout(args []string) {
	fs := flag.NewFlagSet("logout", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath, "path to runtime.toml")
	_ = fs.Parse(args)

	resolved, err := expandedConfigPath(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "logout: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("local-runtime-helper logout")
	fmt.Printf("Local config: %s\n", resolved)
	fmt.Println("To disconnect this machine:")
	fmt.Println("  1. Stop the helper service if it is running.")
	fmt.Println("  2. Revoke this machine's local runtime token from the Harper dashboard.")
	fmt.Println("  3. Remove or replace the token value in runtime.toml.")
	fmt.Println()
	fmt.Println("The helper does not call the cloud revoke endpoint yet; token revocation is managed from the dashboard.")
}
