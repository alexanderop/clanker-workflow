import { Box, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { reduce, initialRunState } from "@workflow/core";
import type { RunState, WorkflowEvent } from "@workflow/core";
import { Header } from "./Header.js";
import { PhasesColumn } from "./PhasesColumn.js";
import { AgentsColumn } from "./AgentsColumn.js";
import { DetailPane } from "./DetailPane.js";
import { Footer } from "./Footer.js";
import { orderedPhases, agentsInPhase, detailSections, runElapsedMs } from "./selectors.js";
import { navReducer, initialNav, type NavState, type NavCtx } from "./navigation.js";

export type UiAction =
  | { readonly type: "pause" }
  | { readonly type: "stop"; readonly target: { readonly scope: "run" } | { readonly scope: "agent"; readonly key: string } }
  | { readonly type: "restart"; readonly key: string }
  | { readonly type: "save" };

export interface AppProps {
  readonly events: readonly WorkflowEvent[];
  readonly adapter?: string | undefined;
  readonly detailRows?: number;
  readonly onAction?: ((action: UiAction) => void) | undefined;
  readonly animate?: boolean;
  /** Static clock override (ms) for deterministic tests; disables the live ticker. */
  readonly now?: number | undefined;
}

export function App({ events, adapter, detailRows = 12, onAction, animate = true, now: nowOverride }: AppProps) {
  const state: RunState = useMemo(() => events.reduce(reduce, initialRunState()), [events]);

  const [nav, setNav] = useState<NavState>(initialNav);
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(() => nowOverride ?? Date.now());

  // Live ticker: bump the spinner frame + wall clock ~4×/sec while the run is active,
  // so elapsed time visibly advances even when no events arrive (a long `claude -p`).
  // The UI is a normal process — the sandbox's Date.now() ban only applies to the VM.
  useEffect(() => {
    if (nowOverride !== undefined || !animate || state.status !== "running") return;
    const id = setInterval(() => {
      setFrame((f) => f + 1);
      setNow(Date.now());
    }, 250);
    return () => clearInterval(id);
  }, [animate, state.status, nowOverride]);

  const phases = useMemo(() => orderedPhases(state), [state]);
  const selectedPhase = phases[Math.min(nav.phaseIndex, Math.max(0, phases.length - 1))];
  const agents = useMemo(
    () => (selectedPhase ? agentsInPhase(state, selectedPhase.title) : []),
    [state, selectedPhase],
  );
  const selectedAgent = agents[Math.min(nav.agentIndex, Math.max(0, agents.length - 1))];
  const detailTotal = selectedAgent ? detailSections(selectedAgent, now, nav.expanded).length : 1;

  // Latest values for the input handler, kept in refs to avoid stale closures.
  const ctxRef = useRef<NavCtx>({ phaseCount: 0, agentCount: 0, maxScroll: 0 });
  ctxRef.current = {
    phaseCount: phases.length,
    agentCount: agents.length,
    maxScroll: Math.max(0, detailTotal - detailRows),
  };
  const navRef = useRef(nav);
  navRef.current = nav;
  const selectedAgentKeyRef = useRef<string | undefined>(undefined);
  selectedAgentKeyRef.current = selectedAgent?.key;

  useInput((input, key) => {
    if (key.upArrow) setNav((p) => navReducer(p, { type: "up" }, ctxRef.current));
    else if (key.downArrow) setNav((p) => navReducer(p, { type: "down" }, ctxRef.current));
    else if (key.rightArrow) setNav((p) => navReducer(p, { type: "right" }, ctxRef.current));
    else if (key.leftArrow) setNav((p) => navReducer(p, { type: "left" }, ctxRef.current));
    else if (key.return) setNav((p) => navReducer(p, { type: "enter" }, ctxRef.current));
    else if (key.escape) setNav((p) => navReducer(p, { type: "esc" }, ctxRef.current));
    else if (input === "j") setNav((p) => navReducer(p, { type: "scrollDown" }, ctxRef.current));
    else if (input === "k") setNav((p) => navReducer(p, { type: "scrollUp" }, ctxRef.current));
    else if (input === "p") onAction?.({ type: "pause" });
    else if (input === "x") {
      const agentKey = selectedAgentKeyRef.current;
      if (navRef.current.focus !== "phases" && agentKey) onAction?.({ type: "stop", target: { scope: "agent", key: agentKey } });
      else onAction?.({ type: "stop", target: { scope: "run" } });
    } else if (input === "r") {
      const agentKey = selectedAgentKeyRef.current;
      if (agentKey) onAction?.({ type: "restart", key: agentKey });
    } else if (input === "s") onAction?.({ type: "save" });
  });

  return (
    <Box flexDirection="column">
      <Header state={state} elapsedMs={runElapsedMs(state, now)} adapter={adapter} />
      <Box>
        <PhasesColumn phases={phases} selectedIndex={nav.phaseIndex} focused={nav.focus === "phases"} frame={frame} />
        <AgentsColumn
          agents={agents}
          selectedIndex={nav.agentIndex}
          focused={nav.focus === "agents"}
          phaseTitle={selectedPhase?.title ?? ""}
          frame={frame}
          now={now}
        />
        <DetailPane
          agent={selectedAgent}
          scroll={nav.scroll}
          rows={detailRows}
          focused={nav.focus === "detail"}
          now={now}
          expanded={nav.expanded}
        />
      </Box>
      <Footer focus={nav.focus} />
    </Box>
  );
}
