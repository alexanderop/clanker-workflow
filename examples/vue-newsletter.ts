export const meta = {
  name: "vue-newsletter",
  description: "Aggregate Vue/Nuxt news from multiple sources into a curated weekly digest",
  phases: [
    { title: "Collect", detail: "gather items from each source in parallel" },
    { title: "Curate", detail: "dedupe and pick the most newsworthy" },
    { title: "Write", detail: "compose the digest" },
  ],
} as const;

const defaultSources = ["GitHub releases (vuejs, nuxt)", "Hacker News", "Reddit r/vuejs", "dev.to Vue tag", "official Vue & Nuxt blogs"];
const sources =
  args && typeof args === "object" && "sources" in args && Array.isArray((args as { sources: unknown }).sources)
    ? ((args as { sources: unknown[] }).sources).map(String)
    : defaultSources;

phase("Collect");
const collected = await parallel(
  sources.map((src, i) => () =>
    agent(`Find the most notable recent Vue/Nuxt news from: ${src}. Return up to 5 items, one per line, formatted "title — one-line summary".`, {
      label: `collect:${i}`,
      phase: "Collect",
    }),
  ),
);
const items = collected.filter(Boolean).flatMap((r) => String(r).split("\n")).map((s) => s.trim()).filter(Boolean);

phase("Curate");
const curated = await agent(
  `From these ${items.length} candidate news items, select the 10 most newsworthy and remove near-duplicates. Keep the "title — summary" format, one per line.\n${items.map((i) => `- ${i}`).join("\n")}`,
  { label: "curate", phase: "Curate" },
);

phase("Write");
const digest = await agent(
  `Write a friendly, skimmable weekly Vue/Nuxt newsletter digest from these curated items. Group by theme and add a short intro.\n\n${String(curated)}`,
  { label: "write", phase: "Write" },
);

return { sourceCount: sources.length, itemCount: items.length, digest: String(digest) };
