/**
 * Experiment 3: Coding task — write new code matching conventions.
 *
 * Task: "Write a new tool called 'Count' that takes a file path and returns
 *        the number of lines. Match the existing tool conventions."
 *
 * Tests whether the REPL approach helps the model write code that FITS
 * the codebase by letting it see multiple reference implementations at once.
 */
import { ReplBridge } from "./bridge.js";

const REPL_BLOCK = `
# Task: write a new "Count" tool (counts lines in a file) matching existing patterns

# 1. Find existing tools — look at the tools/ directory
tool_files = [f for f in codebase.list_files() if f.startswith("tools/") and not f.endswith(".test.ts")]
print(f"[spike] found {len(tool_files)} tool files")

# 2. Find the Tool interface definition
type_matches = codebase.search("tool")
# Look at types.ts specifically
types_context = codebase.get_file_summary("tools/types.ts")
print(f"[spike] tools/types.ts symbols: {[s['name'] for s in types_context['symbols']]}")

# 3. Pick three reference implementations — a simple one, a medium one, one with fs
reference_tools = ["tools/read.ts", "tools/glob.ts"]
print(f"[spike] studying reference tools: {reference_tools}")

# 4. Extract the interface contract
interface_ctx = codebase.get_context("tools/types.ts")
contract = rlm_call(
    interface_ctx,
    "What is the exact Tool interface contract? List required fields and method signatures.",
    budget=300,
)

# 5. Extract the pattern from reference implementations (parallel in spirit)
reference_contexts = []
for file in reference_tools:
    ctx = codebase.get_context(file)
    reference_contexts.append(f"=== {file} ===\\n{ctx}")

pattern = rlm_call(
    "\\n\\n".join(reference_contexts),
    "Extract the common implementation pattern for tools: imports, class structure, execute method shape, error handling, how results are returned. Be prescriptive.",
    budget=500,
)

# 6. Find the registry to know where to register the new tool
registry_ctx = codebase.get_context("tools/registry.ts")
registration = rlm_call(
    registry_ctx,
    "How are new tools registered in createCoreRegistry? Show me the exact pattern.",
    budget=300,
)

# 7. Synthesize — write the Count tool matching all conventions
specification = f"""
## Tool Interface Contract
{contract}

## Implementation Pattern (from read.ts, glob.ts)
{pattern}

## Registration Pattern
{registration}

## Task
Write the complete Count tool as TypeScript code that exactly matches these conventions. The tool should:
- Accept a file path (required) and optional encoding
- Return the number of lines in the file
- Handle errors (file not found, etc.)
- Match the existing file's imports, class structure, execute signature, and error handling.
"""

new_tool_code = rlm_call(
    specification,
    "Write ONLY the complete contents of tools/count.ts as valid TypeScript. Match all conventions exactly. No explanation, just the code.",
    budget=1000,
)

print("")
print("=" * 60)
print("GENERATED tools/count.ts")
print("=" * 60)
print(new_tool_code)
print("")
print("=" * 60)
print("REGISTRATION")
print("=" * 60)
registration_snippet = rlm_call(
    registry_ctx,
    "Show me the exact lines to add to createCoreRegistry() to register the new Count tool. Just the lines to add.",
    budget=200,
)
print(registration_snippet)
`;

async function main() {
  console.log("[spike e3] starting body...");
  const bridge = new ReplBridge();
  await bridge.waitReady();
  console.log("[spike e3] executing...");

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
  console.error("[spike e3] fatal:", e);
  process.exit(1);
});
