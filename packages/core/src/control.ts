export interface AgentControl {
  stopAgent(key: string): void;
  restartAgent(key: string): void;
}

export interface ControlRegistry extends AgentControl {
  register(key: string, controller: AbortController, requestRestart: () => void): () => void;
}

export function createControlRegistry(): ControlRegistry {
  const map = new Map<string, { controller: AbortController; requestRestart: () => void }>();
  return {
    register(key, controller, requestRestart) {
      map.set(key, { controller, requestRestart });
      return () => {
        if (map.get(key)?.controller === controller) map.delete(key);
      };
    },
    stopAgent(key) {
      const e = map.get(key);
      if (e) e.controller.abort();
    },
    restartAgent(key) {
      const e = map.get(key);
      if (e) {
        e.requestRestart();
        e.controller.abort();
      }
    },
  };
}
