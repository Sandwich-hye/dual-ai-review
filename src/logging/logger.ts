import fs from "node:fs";
import path from "node:path";
import { LogLevel } from "../types";

export interface Logger {
  info(component: string, message: string): void;
  warn(component: string, message: string): void;
  error(component: string, message: string): void;
  logFile: string;
}

function stampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function createLogger(logDirectory = path.resolve(process.cwd(), "logs"), now = new Date()): Logger {
  fs.mkdirSync(logDirectory, { recursive: true });
  const logFile = path.join(logDirectory, `run-${stampForFilename(now)}.log`);

  const write = (level: LogLevel, component: string, message: string): void => {
    const line = `[${new Date().toISOString()}] [${level}] [${component}] ${message}`;
    console.log(line);
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
  };

  return {
    logFile,
    info: (component, message) => write("INFO", component, message),
    warn: (component, message) => write("WARN", component, message),
    error: (component, message) => write("ERROR", component, message)
  };
}
