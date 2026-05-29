import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const isWindows = process.platform === 'win32';

const venvPython = isWindows
  ? resolve(repoRoot, '.venv', 'Scripts', 'python.exe')
  : resolve(repoRoot, '.venv', 'bin', 'python');

const candidates = [
  venvPython,
  process.env.PYTHON,
  isWindows ? 'python' : 'python3',
  'python',
].filter(Boolean);

const python = candidates.find((candidate) => {
  return candidate === process.env.PYTHON || !isAbsolute(candidate) || existsSync(candidate);
});

const child = spawn(
  python,
  ['-m', 'uvicorn', 'backend.main:app', '--reload', '--port', '8000'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(`Falha ao iniciar o backend com '${python}': ${error.message}`);
  process.exit(1);
});
