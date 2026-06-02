import type {
  LocalRuntimeConfigResponse,
  RegisterLocalRuntimeResponse,
} from "../../../api/local-runtime";
import { Button } from "../../ui/Button";
import { downloadText, LOCAL_HELPER_INSTALL_COMMAND } from "./utils";

type ConfigPanelInput =
  | LocalRuntimeConfigResponse
  | RegisterLocalRuntimeResponse;

type Props = {
  config: ConfigPanelInput;
  onClear?: () => void;
};

export function LocalRuntimeConfigPanel({ config, onClear }: Props) {
  const filename = "filename" in config ? config.filename : "runtime.toml";
  const tokenAvailable = !("tokenAvailable" in config) || config.tokenAvailable;

  return (
    <div className="rounded-md border border-green-600/30 bg-green-950/20 p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold text-green-200">
            Relay setup commands
          </h4>
          <p className="mt-1 text-xs text-green-300/80">
            {tokenAvailable
              ? "Install the relay helper, save the generated config, then start the relay."
              : "The existing token cannot be shown again. Reset the token to generate a complete config."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void navigator.clipboard.writeText(config.configSnippet)
            }
          >
            Copy config
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => downloadText(filename, config.configSnippet)}
          >
            Download
          </Button>
          {onClear && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              Dismiss
            </Button>
          )}
        </div>
      </div>
      <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-white/5 bg-slate-950/80 px-3 py-2">
        <code className="min-w-0 truncate text-xs text-slate-300">
          {LOCAL_HELPER_INSTALL_COMMAND}
        </code>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void navigator.clipboard.writeText(LOCAL_HELPER_INSTALL_COMMAND)
          }
        >
          Copy install
        </Button>
      </div>
      <pre className="max-h-64 overflow-auto rounded-md bg-slate-950/80 p-3 text-xs text-slate-300">
        {config.configSnippet}
      </pre>
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <code className="block min-w-0 truncate rounded bg-surface-overlay px-2 py-1 text-xs text-slate-300">
            {config.launchCommand}
          </code>
          <p className="mt-1 text-xs text-green-300/70">
            Save the snippet as <code>{filename}</code>, then run this command
            from the <code>local-runtime-helper</code> repo root.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void navigator.clipboard.writeText(config.launchCommand)
          }
        >
          Copy command
        </Button>
      </div>
    </div>
  );
}
