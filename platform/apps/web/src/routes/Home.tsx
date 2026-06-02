import { Navigate } from "react-router-dom";

import { useAuthStore } from "../stores/auth";

export function Home() {
  const { defaultAgentOnboarding, resolvedAgentId } = useAuthStore();

  if (defaultAgentOnboarding.required) {
    return <Navigate to="/onboarding" replace />;
  }

  if (!resolvedAgentId) {
    return <Navigate to="/settings/agents" replace />;
  }

  return <Navigate to={`/dashboard/${resolvedAgentId}`} replace />;
}
