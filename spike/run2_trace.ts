/**
 * Experiment 2: Architectural trace (harder task).
 *
 * Task: "Trace the flow from user keystroke → final tool execution. What transforms the input at each stage?"
 *
 * This is harder than the permissions task — requires following the data flow
 * through multiple files, not just clustering keyword hits.
 */
import { ReplBridge } from "./bridge.js";

const REPL_BLOCK = `
# Task: trace user input → tool execution flow

# Start from the UI layer — where user input enters
ui_matches = codebase.search("message")
ui_files = codebase.cluster_by_file(ui_matches)

# Focus on key files in the flow
flow_files = ["ui/app.tsx", "ui/input.tsx", "loop.ts", "tools/execution.ts"]
print(f"[spike] tracing flow through {len(flow_files)} files")

# For each stage, get focused context and ask what it does with input
stage_analyses = []
for file in flow_files:
    summary = codebase.get_file_summary(file)
    if "error" in summary:
        print(f"[spike] skipping {file} (not found)")
        continue

    # Get the file's structural overview
    context = codebase.get_context(file)
    analysis = rlm_call(
        context,
        f"In {file}, what happens to user input/messages? Trace the transformations. Be specific about function names.",
        budget=400,
    )
    stage_analyses.append(f"### {file}\\n{analysis}")

# Synthesize the full flow
combined = "\\n\\n".join(stage_analyses)
print(f"[spike] synthesizing end-to-end flow from {len(stage_analyses)} stages")

flow = rlm_call(
    combined,
    "Trace the complete flow from user keystroke to tool execution. List the stages in order. Name the specific functions/methods at each transformation. Mention any interceptors (permission checks, hooks, transformations).",
    budget=1000,
)

print("")
print("=" * 60)
print("FLOW TRACE")
print("=" * 60)
print(flow)
`;

async function main() {
  console.log("[spike e2] starting body...");
  const bridge = new ReplBridge();
  await bridge.waitReady();
  console.log("[spike e2] executing...");

  const start = Date.now();
  const result = await bridge.exec(REPL_BLOCK);
  const wallMs = Date.now() - start;

  console.log("");
  console.log("=".repeat(60));
  console.log("STDOUT");
  console.log("=".repeat(60));
  console.log(result.stdout);

  if (result.exception) {
    console.log("EXCEPTION:", result.exception);
  }

  console.log("=".repeat(60));
  console.log("METRICS");
  console.log("=".repeat(60));
  console.log(`Wall time:       ${wallMs}ms`);
  console.log(`rlm_call count:  ${result.rlm_stats.call_count}`);
  console.log(`Total tokens:    ${result.rlm_stats.total_tokens}`);
  console.log("");
  for (const call of result.rlm_stats.calls) {
    console.log(`  - "${call.question.slice(0, 60)}..." in=${call.input_tokens} out=${call.output_tokens}`);
  }

  bridge.shutdown();
}

main().catch((e) => {
  console.error("[spike e2] fatal:", e);
  process.exit(1);
});
