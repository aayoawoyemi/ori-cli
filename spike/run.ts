/**
 * Phase 0 Spike Experiment.
 *
 * Task: "Explain the permission system in this codebase."
 *
 * Runs ONE REPL block that:
 *   1. Searches for "permission" across the graph
 *   2. Clusters matches by file
 *   3. Fans out rlm_call per file cluster for role summaries
 *   4. Synthesizes a unified explanation
 *
 * Measures: token cost, call count, wall-clock time.
 */
import { ReplBridge } from "./bridge.js";

const REPL_BLOCK = `
# Task: explain the permission system in this codebase

matches = codebase.search("permission")
print(f"[spike] found {len(matches)} permission matches")

clusters = codebase.cluster_by_file(matches)
print(f"[spike] clustered across {len(clusters)} files")
print(f"[spike] files: {list(clusters.keys())}")

# Per-cluster summary via fan-out rlm_call
summaries = []
for file_path, file_matches in clusters.items():
    lines = [m["line"] for m in file_matches]
    context = codebase.get_context(file_path, lines, window=4)
    summary = rlm_call(
        context,
        f"What role does permission play in {file_path}? One or two sentences, specific.",
        budget=300,
    )
    summaries.append(f"### {file_path}\\n{summary}")

# Synthesize
all_summaries = "\\n\\n".join(summaries)
print(f"[spike] synthesizing from {len(summaries)} sub-answers")

final = rlm_call(
    all_summaries,
    "Synthesize a unified explanation of the permission system. Describe how it flows from user intent to tool execution. Be specific about the files involved.",
    budget=800,
)

print("")
print("=" * 60)
print("SYNTHESIS")
print("=" * 60)
print(final)
`;

async function main() {
  console.log("[spike] starting body subprocess...");
  const bridge = new ReplBridge();
  await bridge.waitReady();

  console.log("[spike] body ready, pinging...");
  const pong = await bridge.ping();
  console.log(`[spike] ping: ${pong}`);

  console.log("[spike] executing REPL block...");
  const startTime = Date.now();
  const result = await bridge.exec(REPL_BLOCK);
  const wallMs = Date.now() - startTime;

  console.log("");
  console.log("=".repeat(60));
  console.log("STDOUT");
  console.log("=".repeat(60));
  console.log(result.stdout);

  if (result.stderr) {
    console.log("=".repeat(60));
    console.log("STDERR");
    console.log("=".repeat(60));
    console.log(result.stderr);
  }

  if (result.exception) {
    console.log("=".repeat(60));
    console.log("EXCEPTION");
    console.log("=".repeat(60));
    console.log(result.exception);
  }

  console.log("=".repeat(60));
  console.log("METRICS");
  console.log("=".repeat(60));
  console.log(`Wall time:       ${wallMs}ms`);
  console.log(`Body duration:   ${result.duration_ms}ms`);
  console.log(`rlm_call count:  ${result.rlm_stats.call_count}`);
  console.log(`Total tokens:    ${result.rlm_stats.total_tokens}`);
  console.log("");
  console.log("Per-call breakdown:");
  for (const call of result.rlm_stats.calls) {
    console.log(
      `  - "${call.question.slice(0, 60)}..." in=${call.input_tokens} out=${call.output_tokens}`
    );
  }

  bridge.shutdown();
}

main().catch((e) => {
  console.error("[spike] fatal:", e);
  process.exit(1);
});
