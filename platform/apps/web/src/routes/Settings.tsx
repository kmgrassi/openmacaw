import { Navigate, Outlet, useLocation } from "react-router-dom";
import { GatewayProvider } from "../context/GatewayContext";
import { AppShell } from "../components/AppShell";
import { GATEWAY_SETTINGS_PATHS } from "../components/AppShell/settings-sections";

export function SettingsLayout() {
  const { pathname } = useLocation();
  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  const autoConnectGateway = GATEWAY_SETTINGS_PATHS.has(normalizedPathname);

  return (
    <GatewayProvider autoConnect={autoConnectGateway}>
      <AppShell>
        <div className="p-4 md:p-6">
          <Outlet />
        </div>
      </AppShell>
    </GatewayProvider>
  );
}

/** /settings → redirect to /settings/agents */
export function SettingsIndex() {
  return <Navigate to="/settings/agents" replace />;
}
