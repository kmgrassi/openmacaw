import {
  LauncherHttpError,
  LauncherNetworkError,
  LauncherResponseParseError,
  LauncherTimeoutError,
} from "./launcher.js";

export function isLauncherError(error: unknown) {
  return (
    error instanceof LauncherHttpError ||
    error instanceof LauncherNetworkError ||
    error instanceof LauncherTimeoutError ||
    error instanceof LauncherResponseParseError
  );
}
