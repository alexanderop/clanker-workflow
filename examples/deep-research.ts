export const meta = {
  name: "deep-research",
  description: "Fan-out web research, adversarially verify each claim, synthesize a cited report",
  phases: [
    { title: "Scope", detail: "break the question into search angles" },
    { title: "Search", detail: "research each angle in parallel" },
    { title: "Verify", detail: "3-vote adversarial check per claim" },
    { title: "Synthesize", detail: "write the report from confirmed claims" },
  ],
} as const;

const question = args && typeof args === "object" && "question" in args ? String((args as { question: unknown }).question) : "";
if (!question) return { error: "provide --args '{\"question\":\"…\"}'" };

phase("Scope");
const scopeText = await agent(
  `Break this research question into 5 distinct, non-overlapping search angles. Return one angle per line, no numbering.\n\nQuestion: ${question}`,
  { label: "scope" },
);
const angles = String(scopeText).split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 5);

phase("Search");
const searched = await parallel(
  angles.map((angle, i) => () =>
    agent(`Research this angle of the question "${question}":\n${angle}\n\nReturn the key findings as short factual claims, one per line.`, {
      label: `search:${i}`,
      phase: "Search",
    }),
  ),
);
const rawClaims = searched.filter(Boolean).flatMap((r) => String(r).split("\n")).map((s) => s.trim()).filter(Boolean);

// Dedupe in plain code (no agent needed).
const seen = new Set<string>();
const claims: string[] = [];
for (const c of rawClaims) {
  const k = c.toLowerCase();
  if (!seen.has(k)) { seen.add(k); claims.push(c); }
}
log(`verifying ${claims.length} unique claims`);

phase("Verify");
const judged = await parallel(
  claims.map((claim, i) => () =>
    parallel(
      [0, 1, 2].map((v) => () =>
        agent(`Adversarially fact-check this claim about "${question}". Default to REFUTED if uncertain. Reply with REAL or REFUTED and a one-line reason.\n\nClaim: ${claim}`, {
          label: `verify:${i}:${v}`,
          phase: "Verify",
        }),
      ),
    ).then((votes) => {
      const real = votes.filter(Boolean).filter((vote) => /\bREAL\b/i.test(String(vote))).length;
      return { claim, confirmed: real >= 2 };
    }),
  ),
);
const confirmed = judged.filter(Boolean).filter((j) => j!.confirmed).map((j) => j!.claim);

phase("Synthesize");
const report = await agent(
  `Synthesize a concise, well-structured research report answering "${question}". Use ONLY these verified findings; cite them inline:\n${confirmed.map((c) => `- ${c}`).join("\n")}`,
  { label: "synthesize", phase: "Synthesize" },
);

return { question, confirmedCount: confirmed.length, confirmed, report: String(report) };
