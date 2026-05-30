import { parseArgs } from "node:util";
import type { AppDeps } from "./app.js";
import { runCommand } from "./commands/run.js";
import { runDetachedCommand } from "./commands/run-detached.js";
import { watchCommand } from "./commands/watch.js";
import { listCommand } from "./commands/list.js";
import { resumeCommand } from "./commands/resume.js";
import { stopCommand } from "./commands/stop.js";
import { saveCommand } from "./commands/save.js";
import { adaptersCommand } from "./commands/adapters.js";
import { resolveSavedWorkflow } from "./resolve.js";

export const USAGE = `workflow — deterministic multi-agent workflow runner

Usage:
  workflow run <script> [--args '{...}'] [--detach] [--yes] [--mock]
  workflow watch <id>            attach the UI to a running/finished run
  workflow list                  list runs (status, tokens, elapsed)
  workflow resume <id>           replay the journal, run the rest live
  workflow stop <id>             stop a backgrounded run
  workflow save <id>             save a run's script as a named workflow
  workflow adapters              list detected harnesses + capabilities
  workflow <name> [--args ...]   run a saved/bundled workflow by name
`;

const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** Parse argv and route to a command. Pure over the injected AppDeps so it is fully testable. */
export async function dispatch(argv: readonly string[], deps: AppDeps): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: false,
      options: {
        args: { type: "string" },
        model: { type: "string" },
        detach: { type: "boolean" },
        yes: { type: "boolean" },
        mock: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
  } catch (e) {
    deps.ui.print(`error: ${(e as Error).message}\n`);
    return 1;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values["help"] || command === undefined) {
    deps.ui.print(USAGE);
    return command === undefined && !values["help"] ? 1 : 0;
  }

  const runFlags = {
    argsJson: str(values["args"]),
    detach: values["detach"] === true,
    yes: values["yes"] === true,
    mock: values["mock"] === true,
  };
  const requireId = (label: string): string | undefined => {
    const id = positionals[1];
    if (id === undefined) deps.ui.print(`error: ${label} requires a run id\n`);
    return id;
  };

  switch (command) {
    case "run": {
      const script = positionals[1];
      if (script === undefined) {
        deps.ui.print("error: run requires a script path\n");
        return 1;
      }
      return runCommand({ script, ...runFlags }, deps);
    }
    case "__run-detached": {
      const id = requireId("__run-detached");
      return id === undefined ? 1 : runDetachedCommand(id, deps);
    }
    case "watch": {
      const id = requireId("watch");
      return id === undefined ? 1 : watchCommand(id, deps);
    }
    case "list":
      return listCommand(deps);
    case "resume": {
      const id = requireId("resume");
      return id === undefined ? 1 : resumeCommand(id, deps);
    }
    case "stop": {
      const id = requireId("stop");
      return id === undefined ? 1 : stopCommand(id, deps);
    }
    case "save": {
      const id = requireId("save");
      return id === undefined ? 1 : saveCommand(id, deps);
    }
    case "adapters":
      return adaptersCommand(deps);
    default: {
      // Treat an unknown command as a saved/bundled workflow name.
      const resolved = resolveSavedWorkflow(command, { homeDir: deps.env.homeDir, cwd: deps.env.cwd, readFile: deps.io.readText });
      if (!resolved) {
        deps.ui.print(`error: unknown command or workflow '${command}'\n`);
        return 1;
      }
      return runCommand({ script: resolved.path, ...runFlags }, deps);
    }
  }
}
