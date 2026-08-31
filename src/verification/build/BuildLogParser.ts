import type {
  BuildDiagnostic,
  BuildErrorCategory,
  BuildStage
} from "./BuildSchemas.js";

export interface ParsedBuildLog {
  stage: BuildStage;
  errors: BuildDiagnostic[];
  warnings: BuildDiagnostic[];
  lines: number;
  complete: boolean;
}

/** Deterministic parser for common CCS/TI compiler and linker diagnostics. */
export class BuildLogParser {
  parse(text: string): ParsedBuildLog {
    const errors: BuildDiagnostic[] = [];
    const warnings: BuildDiagnostic[] = [];
    const lines = text.split(/\r?\n/);
    let stage: BuildStage = inferStage(text);

    for (const [index, line] of lines.entries()) {
      const severity = diagnosticSeverity(line);
      if (!severity) continue;
      const location = parseLocation(line);
      const code = parseDiagnosticCode(line);
      const category = classifyDiagnostic(line, severity);
      const diagnostic: BuildDiagnostic = {
        tool: inferTool(line, category),
        code,
        category,
        message: cleanMessage(line),
        file: location.file,
        line: location.line,
        column: location.column,
        raw: line.trim()
      };
      if (category === "COMPILE_ERROR") stage = "compile";
      else if (category !== "UNKNOWN" || /\blink(?:er)?\b|\.map\b|\.out\b/i.test(line)) stage = "link";
      if (severity === "error") errors.push(diagnostic);
      else warnings.push(diagnostic);
    }

    return {
      stage,
      errors: deduplicate(errors),
      warnings: deduplicate(warnings),
      lines: lines.length,
      complete: text.trim().length > 0
    };
  }
}

export function parseBuildLog(text: string): ParsedBuildLog {
  return new BuildLogParser().parse(text);
}

function diagnosticSeverity(line: string): "error" | "warning" | undefined {
  if (/\bfatal\s+error\b|\berror\b|>>\s*ERROR\b/i.test(line)) return "error";
  if (/\bwarning\b|>>\s*WARNING\b/i.test(line)) return "warning";
  return undefined;
}

function inferStage(text: string): BuildStage {
  if (/\b(link(?:er)?|unresolved symbol|section .*overflow|memory placement)\b|\.map\b/i.test(text)) return "link";
  if (/\b(compile|compiler|assembl(?:e|y))\b|\.(?:c|cc|cpp|h|asm)\b/i.test(text)) return "compile";
  if (/\b(build|project)\s+(?:complete|succeeded|finished)\b/i.test(text)) return "post-link";
  return "unknown";
}

function classifyDiagnostic(line: string, severity: "error" | "warning"): BuildErrorCategory {
  const value = line.toLowerCase();
  if (/abi|eabi|coff|calling convention|object file format|incompatible.*object/.test(value)) return "ABI_MISMATCH";
  if (/undefined symbol|unresolved symbol|symbol .* (?:not found|undefined)|could not resolve/.test(value)) return "UNRESOLVED_SYMBOL";
  if (/multiple definition|redefined|duplicate symbol/.test(value)) return "MULTIPLE_DEFINITION";
  if (/will not fit|section .*overflow|overflow(?:ed)?|placement fails.*section/.test(value)) return "SECTION_OVERFLOW";
  if (/cannot place|memory placement|placement.*failed|no room in memory|region .* overflow/.test(value)) return "MEMORY_PLACEMENT";
  if (/project\s+(?:configuration|config)|configuration\s+(?:is\s+)?(?:invalid|missing|error)|ccs\s+project/.test(value)) return "PROJECT_CONFIG_ERROR";
  if (/toolchain|compiler .*not found|cl[0-9]+ .*not found|ti-cgt|dss.*not found/.test(value)) return "TOOLCHAIN_NOT_FOUND";
  if (/timeout|timed out/.test(value)) return "TIMEOUT";
  if (/cannot open|no such file|file .*not found|missing file|can't find/.test(value)) return "MISSING_FILE";
  if (severity === "error" && /(?:\.c|\.h|\.cpp|\.asm)(?::|\(|\s)/i.test(line)) return "COMPILE_ERROR";
  if (severity === "error" && /link(?:er)?|\.map|\.out|section|memory/.test(value)) return "LINK_ERROR";
  return "UNKNOWN";
}

function inferTool(line: string, category: BuildErrorCategory): string {
  if (["COMPILE_ERROR", "MISSING_FILE"].includes(category) && /\.(?:c|cc|cpp|h|asm)\b/i.test(line)) return "compiler";
  if (["LINK_ERROR", "ABI_MISMATCH", "UNRESOLVED_SYMBOL", "MULTIPLE_DEFINITION", "SECTION_OVERFLOW", "MEMORY_PLACEMENT"].includes(category)) return "linker";
  if (category === "TOOLCHAIN_NOT_FOUND") return "toolchain";
  return "build";
}

function parseDiagnosticCode(line: string): string | null {
  const match = /(?:error|warning)\s*(?:#|code\s*)?([A-Za-z]?\d+(?:-[A-Za-z])?)/i.exec(line);
  return match?.[1] ?? null;
}

function parseLocation(line: string): { file: string | null; line: number | null; column: number | null } {
  // CCS often emits `"foo.c", line 17: error #...`; GCC-like output is
  // `foo.c:17:4: error`. Greedy matching preserves Windows drive letters.
  const ccs = /["']([^"']+)["']\s*,\s*line\s+(\d+)/i.exec(line);
  if (ccs) return { file: ccs[1]!, line: Number(ccs[2]), column: null };
  const gcc = /^(.*?):(\d+)(?::(\d+))?:\s*(?:fatal\s+)?(?:error|warning)\b/i.exec(line.trim());
  if (gcc) return { file: gcc[1]!, line: Number(gcc[2]), column: gcc[3] ? Number(gcc[3]) : null };
  return { file: null, line: null, column: null };
}

function cleanMessage(line: string): string {
  return line.trim().replace(/^.*?:\s*(?=(?:fatal\s+)?(?:error|warning)\b)/i, "");
}

function deduplicate(values: BuildDiagnostic[]): BuildDiagnostic[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = JSON.stringify([value.category, value.code, value.file, value.line, value.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
