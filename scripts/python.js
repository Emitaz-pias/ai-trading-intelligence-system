const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const explicit = process.env.PYTHON;
const candidates = explicit ? [explicit] : process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python'];
let lastError;
for (const executable of candidates) {
  const args = executable === 'py' ? ['-3', ...process.argv.slice(2)] : process.argv.slice(2);
  const result = spawnSync(executable, args, { cwd: repoRoot, stdio: 'inherit', env: process.env });
  if (!result.error) process.exit(result.status ?? 1);
  lastError = result.error;
  if (explicit) break;
}
console.error(`Python could not be started${explicit ? ` using PYTHON=${explicit}` : ''}. Install Python 3.12+ or set PYTHON to its executable.`, lastError?.message || '');
process.exit(1);
