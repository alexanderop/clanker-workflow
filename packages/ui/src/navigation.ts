export type FocusColumn = "phases" | "agents" | "detail";

export interface NavState {
  readonly focus: FocusColumn;
  readonly phaseIndex: number;
  readonly agentIndex: number;
  readonly scroll: number;
}

export type NavAction =
  | { readonly type: "up" }
  | { readonly type: "down" }
  | { readonly type: "left" }
  | { readonly type: "right" }
  | { readonly type: "esc" }
  | { readonly type: "scrollUp" }
  | { readonly type: "scrollDown" };

export interface NavCtx {
  readonly phaseCount: number;
  readonly agentCount: number;
  readonly maxScroll: number;
}

export const initialNav: NavState = { focus: "phases", phaseIndex: 0, agentIndex: 0, scroll: 0 };

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export function navReducer(state: NavState, action: NavAction, ctx: NavCtx): NavState {
  switch (action.type) {
    case "up":
      if (state.focus === "phases")
        return { ...state, phaseIndex: clamp(state.phaseIndex - 1, 0, Math.max(0, ctx.phaseCount - 1)), agentIndex: 0, scroll: 0 };
      if (state.focus === "agents")
        return { ...state, agentIndex: clamp(state.agentIndex - 1, 0, Math.max(0, ctx.agentCount - 1)), scroll: 0 };
      return state;
    case "down":
      if (state.focus === "phases")
        return { ...state, phaseIndex: clamp(state.phaseIndex + 1, 0, Math.max(0, ctx.phaseCount - 1)), agentIndex: 0, scroll: 0 };
      if (state.focus === "agents")
        return { ...state, agentIndex: clamp(state.agentIndex + 1, 0, Math.max(0, ctx.agentCount - 1)), scroll: 0 };
      return state;
    case "right":
      if (state.focus === "phases") return { ...state, focus: "agents" };
      if (state.focus === "agents") return { ...state, focus: "detail" };
      return state;
    case "left":
      if (state.focus === "detail") return { ...state, focus: "agents" };
      if (state.focus === "agents") return { ...state, focus: "phases" };
      return state;
    case "esc":
      return { ...state, focus: "phases" };
    case "scrollUp":
      return { ...state, scroll: clamp(state.scroll - 1, 0, ctx.maxScroll) };
    case "scrollDown":
      return { ...state, scroll: clamp(state.scroll + 1, 0, ctx.maxScroll) };
  }
}
