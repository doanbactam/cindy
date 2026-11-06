import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createLogger } from '../logger.js';
import { assertHelperCommandSucceeded, waitForSpawnedProcess } from './macHelperProcess.js';

const log = createLogger('worklouder-codex-system-input');

const HELPER_FAILED_MESSAGE = 'Could not run macOS system input helper.';
const DEFAULT_COMMAND_TIMEOUT_MS = 2500;
const HELPER_RESOURCE = path.join('tools', 'worklouder', 'xdt-macos-text-insertion-helper');
const HELPER_SOURCE_RELATIVE = path.join('native', 'worklouder', 'macos-text-insertion-helper.swift');

type HelperResult = { ok?: boolean; error?: string | null; reason?: string };

function execFilePromise(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr?.toString().trim();
        reject(new Error(`${HELPER_FAILED_MESSAGE} ${detail || error.message}`));
        return;
      }
      resolve(stdout?.toString() ?? '');
    });
  });
}

/** The helper prints optional progress lines; the last JSON line is the command result. */
function parseHelperResult(stdout: string): HelperResult {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (lastLine === undefined) throw new Error('Empty helper response');
  return JSON.parse(lastLine) as HelperResult;
}

let helperPathPromise: Promise<string> | null = null;

function resolveHelperPath(): Promise<string> {
  if (helperPathPromise) return helperPathPromise;
  helperPathPromise = (async () => {
    const packagedPath = path.join(process.resourcesPath, HELPER_RESOURCE);
    if (fs.existsSync(packagedPath)) return packagedPath;
    await buildDevHelper();
    return devHelperBinary();
  })().catch((error) => {
    helperPathPromise = null;
    throw error;
  });
  return helperPathPromise;
}

async function buildDevHelper(): Promise<void> {
  const appPathSource = path.join(app.getAppPath(), HELPER_SOURCE_RELATIVE);
  const source = fs.existsSync(appPathSource)
    ? appPathSource
    : path.join(__dirname, '..', '..', HELPER_SOURCE_RELATIVE);
  const binary = devHelperBinary();
  if (!fs.existsSync(source)) throw new Error(`${HELPER_FAILED_MESSAGE} Helper source missing at ${source}`);
  if (fs.existsSync(binary) && fs.statSync(binary).mtimeMs >= fs.statSync(source).mtimeMs) return;
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  await execFilePromise('swiftc', [source, '-o', binary], 10_000);
  fs.chmodSync(binary, 0o755);
  log.info('built dev macOS system input helper', { path: binary });
}

function devHelperBinary(): string {
  return path.join(app.getPath('userData'), 'worklouder', 'xdt-macos-text-insertion-helper');
}

/** Run one helper command (post-key, post-scroll) against the frontmost app. */
export async function runMacSystemInputHelperCommand(args: string[]): Promise<void> {
  const helperPath = await resolveHelperPath();
  const stdout = await execFilePromise(helperPath, args, DEFAULT_COMMAND_TIMEOUT_MS);
  let result: HelperResult;
  try {
    result = parseHelperResult(stdout);
  } catch (error) {
    // Never include stdout: it may carry text captured from the user's focused field.
    throw new Error(
      `${HELPER_FAILED_MESSAGE} Invalid helper response: ${error instanceof Error ? error.message : String(error)}. Stdout bytes: ${stdout.length}.`,
    );
  }
  assertHelperCommandSucceeded(result);
}

/** Start a long-lived helper command (hold-scroll) that reads from stdin. */
export async function spawnMacSystemInputHelper(args: string[]) {
  const helperPath = await resolveHelperPath();
  return waitForSpawnedProcess(
    spawn(helperPath, args, { stdio: ['pipe', 'ignore', 'pipe'] }),
    (error) => {
      log.warn('macOS system input helper failed after spawn', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}
