const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

if (!process.env.HARBORMASTER_PATH) {
  throw new Error('Set HARBORMASTER_PATH to a core checkout with dependencies');
}
const core = fs.realpathSync(process.env.HARBORMASTER_PATH);
const sleep = path.resolve(__dirname, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-integration-'));

try {
  // Test a disposable snapshot; the supplied core checkout is never modified.
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: core, encoding: 'utf8',
  }).split('\0').filter(Boolean);
  for (const file of files) {
    const source = path.join(core, file);
    if (!fs.existsSync(source)) continue;
    const target = path.join(workspace, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target);
  }
  fs.symlinkSync(path.join(core, 'node_modules'),
    path.join(workspace, 'node_modules'), 'dir');
  const tests = path.join(workspace, 'imports/harbor-tests/server');
  fs.cpSync(path.join(sleep, 'test/integration'), tests, { recursive: true });
  fs.copyFileSync(path.join(sleep, 'lib/migration.mjs'),
    path.join(tests, 'migration.js'));

  const result = spawnSync('meteor', [
    'test', '--once', '--driver-package', 'meteortesting:mocha',
    '--port', process.env.TEST_PORT || '4050',
  ], {
    cwd: workspace, stdio: 'inherit',
    env: {
      ...process.env, PWD: workspace, ROOT_URL: '', MONGO_URL: '',
      NO_HMR: '1', TEST_CLIENT: '0', TEST_SERVER: '1',
      WHEN_USING_OLD_API: '1', BROWSERSLIST_IGNORE_OLD_DATA: '1',
      MOCHA_GREP: '^(Sleep migration|Sleep and core recovery integration)',
      MOCHA_TIMEOUT: '30000', SLEEP_HARBOR_PATH: path.join(sleep, 'sleep.js'),
    },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
