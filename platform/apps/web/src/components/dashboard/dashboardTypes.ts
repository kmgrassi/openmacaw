import type { fetchAgentHealth, fetchSetup } from "../../api/setup";

export type DashboardSetup = Awaited<ReturnType<typeof fetchSetup>>;
export type DashboardAgentHealth = Awaited<ReturnType<typeof fetchAgentHealth>>;
