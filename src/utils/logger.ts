import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  constructor(
    private readonly level: LogLevel = "info",
    private readonly logFile?: string
  ) {}

  debug(message: string, data?: unknown) {
    this.write("debug", message, data);
  }

  info(message: string, data?: unknown) {
    this.write("info", message, data);
  }

  warn(message: string, data?: unknown) {
    this.write("warn", message, data);
  }

  error(message: string, data?: unknown) {
    this.write("error", message, data);
  }

  private write(level: LogLevel, message: string, data?: unknown) {
    if (levelWeight[level] < levelWeight[this.level]) {
      return;
    }
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      data: serializeData(data)
    });
    if (this.logFile) {
      mkdirSync(path.dirname(this.logFile), { recursive: true });
      appendFileSync(this.logFile, `${line}\n`);
      return;
    }
    process.stderr.write(`${line}\n`);
  }
}

class SilentLogger extends Logger {
  constructor() {
    super("error");
  }

  debug(_message: string, _data?: unknown) {}
  info(_message: string, _data?: unknown) {}
  warn(_message: string, _data?: unknown) {}
  error(_message: string, _data?: unknown) {}
}

function serializeData(data: unknown): unknown {
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack };
  }
  return data;
}

export const noopLogger = new SilentLogger();
