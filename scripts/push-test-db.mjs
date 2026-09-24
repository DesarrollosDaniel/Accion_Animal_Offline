import { spawnSync } from 'node:child_process'
import { assertTestEnvironment } from './test-environment.mjs'

assertTestEnvironment()

const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const result = spawnSync(command, ['--yes', 'supabase@2.117.0', 'db', 'push'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
