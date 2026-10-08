import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const BASIC_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM", "TMPDIR", "TMP", "TEMP", "SystemRoot", "COMSPEC", "PATHEXT"];
// Credentials belonging to the host must never become coding-tool input,
// even when an operator accidentally includes them in the extra allowlist.
const PRIVATE_ENV = /(?:^RAFTD_|^ZAI_|^OPENAI_|^ANTHROPIC_|^MINIMAX(?:_|$)|^DEEPSEEK_|^zhipu$|(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$))/i;

export function toolEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed = new Set([...BASIC_ENV, ...Object.keys(source).filter((k) => /^LC_[A-Z_]+$/.test(k))]);
  for (const name of (source.RAFTD_TOOL_ENV_ALLOW ?? "").split(/[\s,]+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) allowed.add(name);
  }
  return Object.fromEntries([...allowed].filter((name) => !PRIVATE_ENV.test(name) && source[name] !== undefined).map((name) => [name, source[name]!]));
}

/** pi-durable's shellEnv is an overlay on process.env, not a replacement. */
export class ToolExecutionEnv extends NodeExecutionEnv {
  override exec(...[command, options, context]: Parameters<NodeExecutionEnv["exec"]>): ReturnType<NodeExecutionEnv["exec"]> {
    const safeEnv = toolEnvironment();
    // Explicit tool-local variables may be used without granting inheritance
    // of the daemon's environment; host credential names remain forbidden.
    for (const [key, value] of Object.entries(options?.env ?? {})) {
      if (!PRIVATE_ENV.test(key)) safeEnv[key] = value;
    }
    return super.exec(command, { ...options, inheritEnv: false, env: safeEnv }, context);
  }
}
