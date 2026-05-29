export interface JournalEntry {
  readonly seq: number;
  readonly key: string;
  readonly text: string;
  readonly data: unknown;
  readonly outputTokens: number;
}

export interface Journal {
  lookup(seq: number): JournalEntry | undefined;
  record(entry: JournalEntry): void;
  entries(): readonly JournalEntry[];
}

export function createJournal(seed: readonly JournalEntry[] = []): Journal {
  const bySeq = new Map<number, JournalEntry>();
  for (const e of seed) bySeq.set(e.seq, e);
  return {
    lookup: (seq) => bySeq.get(seq),
    record: (entry) => {
      bySeq.set(entry.seq, entry);
    },
    entries: () => [...bySeq.values()].sort((a, b) => a.seq - b.seq),
  };
}
