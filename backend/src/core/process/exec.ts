import util from 'util';
import { exec, execFile, spawn } from 'child_process';

import { normalizeCliText } from '../util';

export const execPromise = util.promisify(exec);
export const execFilePromise = util.promisify(execFile);

export function execFileWithInput(
  file: string,
  args: string[],
  input: string,
  options?: { timeout?: number; env?: NodeJS.ProcessEnv; cwd?: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: options?.env,
      cwd: options?.cwd,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    const finalizeError = (error: any) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };

    const finalizeSuccess = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr });
    };

    if (options?.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, options.timeout);
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      finalizeError(error);
    });

    child.on('close', (code, signal) => {
      if (code === 0 && !timedOut) {
        finalizeSuccess();
        return;
      }

      const error: any = new Error(
        timedOut
          ? `${file} timed out`
          : `${file} exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`
      );
      error.code = code;
      error.signal = signal;
      error.timedOut = timedOut;
      error.stdout = stdout;
      error.stderr = stderr;
      finalizeError(error);
    });

    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

export function readCliErrorDetail(error: any): string {
  return [
    normalizeCliText(error?.stderr),
    normalizeCliText(error?.stdout),
    normalizeCliText(error?.message),
  ].find(Boolean) || '';
}
