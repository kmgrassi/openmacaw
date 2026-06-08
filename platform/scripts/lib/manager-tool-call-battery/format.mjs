export function printResult(result, args) {
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.mode === "dry-run") {
    console.log("manager tool battery dry-run");
    console.log(`agent: ${result.agentId}`);
    console.log(`workspace: ${result.workspaceId}`);
    console.log(`api: ${result.apiBaseUrl}`);
    console.log("");
    console.log("resolved tools:");
    for (const tool of result.resolvedTools) {
      console.log(`  - ${tool.slug} (${tool.executionKind ?? "unknown"}/${tool.runnerKind ?? "unknown"})`);
    }
    console.log("");
    console.log("selected cases:");
    for (const testCase of result.selectedCases) {
      console.log(`  - ${testCase.id}: ${testCase.expectedToolSlugs.join(", ")}`);
    }
    console.log("");
    console.log(result.note);
    return;
  }

  console.log(`manager tool battery ${result.status}`);
  console.log(`artifacts: ${result.artifactDir}`);
  for (const testCase of result.results) {
    const observed = testCase.observedToolSlugs.length > 0 ? testCase.observedToolSlugs.join(", ") : "none";
    console.log(`  ${testCase.status === "passed" ? "PASS" : "FAIL"} ${testCase.id}: observed ${observed}`);
    if (testCase.missingToolSlugs.length > 0) {
      console.log(`       missing ${testCase.missingToolSlugs.join(", ")}`);
    }
    if (testCase.runtimeFailure) {
      const code = testCase.runtimeFailure.errorCode ?? "runtime_failure";
      const message = testCase.runtimeFailure.errorMessage ?? "no message";
      console.log(`       runtime ${code}: ${message}`);
    }
  }
}
