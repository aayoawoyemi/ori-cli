/**
 * Fixture for bench task 02.
 *
 * This intentionally preserves the historical bug from src/tools/code.ts:
 * plain Python imports like `import json` are classified as TS/JS before
 * the import-specific lint can explain that imports are forbidden. Keep this
 * fixture stable so task 02 measures code-repair reasoning instead of whatever
 * the live Aries source happens to contain today.
 */

function stripPythonStringsAndComments(code: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return code
    .replace(/"""[\s\S]*?"""/g, blank)
    .replace(/'''[\s\S]*?'''/g, blank)
    .replace(/"(?:\\.|[^"\\\n])*"/g, blank)
    .replace(/'(?:\\.|[^'\\\n])*'/g, blank)
    .replace(/#[^\n]*/g, blank);
}

export function looksLikeTypeScriptOrJavaScript(code: string): boolean {
  const stripped = stripPythonStringsAndComments(code);
  const tsPatterns = [
    /^\s*import\s+(?:type\s+)?[{*\w]/m,
    /^\s*export\s+(?:type\s+|interface\s+|class\s+|const\s+|function\s+)/m,
    /^\s*(?:const|let|var|function|interface|type)\s+\w+/m,
    /^\s*(?:async\s+)?function\s+\w+\s*\(/m,
    /^\s*\w+\s*:\s*(?:string|number|boolean|unknown|Record<|Array<|\w+\[\])/m,
    /=>/,
  ];
  return tsPatterns.some((pattern) => pattern.test(stripped));
}

export function lintCell(code: string): string | null {
  if (looksLikeTypeScriptOrJavaScript(code)) {
    return 'Looks like TypeScript/JavaScript. code runs Python.';
  }

  const importMatch = code.match(/^\s*(?:import|from)\s+[\w.]+/m);
  if (importMatch) {
    return `Imports are forbidden (you wrote "${importMatch[0].trim()}"). Use pre-loaded namespace primitives.`;
  }

  return null;
}
