/**
 * test/run.mjs — dependency-free smoke and boundary tests for the Host half.
 *
 * Run with `node test/run.mjs`. It builds a fake Host context (no DSH install
 * needed) and exercises prompt assembly, per-turn approval state, command
 * classification, cleanup classification, tracking, and cleanup execution.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { isReadOnlyShell } from '../lib/gate.js'
import {
  classify,
  createCleanupTool,
  createRegistry,
} from '../lib/cleanup.js'

const checks = []
const check = (name, fn) => checks.push({ name, fn })

/** Mirror of the supported keyword subset in @deepseek-ai/dsh-tools. */
const CONSTRAINT_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function validateSchemaSubset(node, label, problems) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    problems.push(`${label}: not a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!CONSTRAINT_KEYS.has(key) && !ANNOTATION_KEYS.has(key)) problems.push(`${label}: unsupported keyword "${key}"`)
  }
  if (node.type !== undefined && !TYPES.has(node.type)) problems.push(`${label}: bad type ${String(node.type)}`)
  if (node.required !== undefined) {
    if (!Array.isArray(node.required)) problems.push(`${label}: required must be an array`)
    else for (const name of node.required) {
      if (node.properties === undefined || !Object.hasOwn(node.properties, name)) {
        problems.push(`${label}: required "${name}" is not declared`)
      }
    }
  }
  if (node.properties !== undefined) {
    for (const [name, child] of Object.entries(node.properties)) validateSchemaSubset(child, `${label}.${name}`, problems)
  }
  if (node.items !== undefined) validateSchemaSubset(node.items, `${label}[]`, problems)
}

function makeHost({ approval = 'allowed-once', withApproval = true, policy = 'ask' } = {}) {
  const sections = []
  const tools = new Map()
  const listeners = new Map()
  const approvalRequests = []
  const warnings = []
  const approvalService = {
    request: async (request) => {
      approvalRequests.push(request)
      return typeof approval === 'function' ? approval(request) : approval
    },
    effectivePolicy: () => policy,
  }
  const ctx = {
    systemPrompt: { section: (section) => sections.push(section) },
    tools: { register: (definition) => { tools.set(definition.name, definition) } },
    logger: { warn: (message) => warnings.push(message) },
    on: (event, listener) => {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
    },
    // Cordis inject scope: the callback only runs once the service exists.
    inject: (deps, callback) => {
      if (deps.includes('approval') && !withApproval) return () => {}
      const scope = { ...ctx, approval: approvalService }
      return callback(scope)
    },
  }
  const call = async (event, ...args) => {
    const bucket = listeners.get(event) ?? []
    const next = async () => ({ kind: 'allow' })
    let handler = next
    for (const listener of [...bucket].reverse()) {
      const downstream = handler
      handler = () => listener(...args, downstream)
    }
    return handler()
  }
  const emit = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  return { ctx, sections, tools, approvalRequests, warnings, call, emit }
}

function makeAgent(session = {}) {
  return { session }
}

check('section text carries all rule blocks', () => {
  const host = makeHost()
  apply(host.ctx, { strictness: 'strict' })
  assert.equal(host.sections.length, 1)
  const text = host.sections[0].text
  assert.equal(host.sections[0].name, 'prework-gate')
  assert.equal(host.sections[0].order, 400)
  for (const needle of ['开工闸门', '当前力度：严格', '一轮问完', '硬闸门', '收尾 — 交付后清掉本轮垃圾']) {
    assert.ok(text.includes(needle), `missing ${needle}`)
  }
})

check('optional blocks and extra rules keep their intended toggles', () => {
  const host = makeHost()
  apply(host.ctx, { grill: false, gate: false, cleanup: false, extraRules: ['删除前先列绝对路径', ''] })
  const text = host.sections[0].text
  assert.ok(!text.includes('一轮问完'))
  assert.ok(!text.includes('未批准的写操作'))
  assert.ok(!text.includes('收尾 — 交付后清掉本轮垃圾'))
  assert.ok(text.includes('删除前先列绝对路径'))
})

check('tools register with schemas inside the supported subset', () => {
  const host = makeHost()
  apply(host.ctx, {})
  assert.deepEqual([...host.tools.keys()].sort(), ['postwork_cleanup', 'prework_plan'])
  for (const definition of host.tools.values()) {
    assert.equal(typeof definition.output.render, 'function')
    const problems = []
    validateSchemaSubset(definition.parameters, 'parameters', problems)
    validateSchemaSubset(definition.output.schema, 'output', problems)
    assert.deepEqual(problems, [], `${definition.name}: ${problems.join('; ')}`)
  }
})

check('plan tool closes the gate and prints the checklist', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const plan = host.tools.get('prework_plan')
  const value = await plan.execute(
    { summary: '升级闸门', steps: ['修改 gate.js', '更新测试'] },
    { agent: makeAgent() },
  )
  assert.equal(value.recorded, true)
  assert.equal(value.gate, 'closed')
  assert.ok(value.plan.includes('1. 修改 gate.js'))
  assert.ok(value.note.includes('批准只在本轮任务内有效'))
  const rendered = plan.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
})

check('one approval unlocks the turn and a new turn re-arms the gate', async () => {
  const host = makeHost({ approval: 'allowed-once' })
  apply(host.ctx, {})
  const agent = makeAgent()
  const write = { name: 'write', agent, arguments: { path: 'a.txt' } }

  await host.call('tools/pre-execute', write)
  assert.equal(host.approvalRequests.length, 1)
  await host.call('tools/pre-execute', { ...write, arguments: { path: 'b.txt' } })
  assert.equal(host.approvalRequests.length, 1, 'second write in the same turn must not ask again')

  host.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 2 } })
  await host.call('tools/pre-execute', { ...write, arguments: { path: 'c.txt' } })
  assert.equal(host.approvalRequests.length, 2, 'a new turn must re-arm without model cooperation')
})

check('plan tool re-arms even inside the same turn', async () => {
  const host = makeHost({ approval: 'allowed-once' })
  apply(host.ctx, {})
  const agent = makeAgent()
  const write = { name: 'write', agent, arguments: {} }
  await host.call('tools/pre-execute', write)
  assert.equal(host.approvalRequests.length, 1)
  await host.tools.get('prework_plan').execute({ summary: '第二个任务' }, { agent })
  await host.call('tools/pre-execute', write)
  assert.equal(host.approvalRequests.length, 2)
})

check('a stale pending approval cannot approve a newly armed plan', async () => {
  let resolveApproval
  const host = makeHost({ approval: () => new Promise((resolve) => { resolveApproval = resolve }) })
  apply(host.ctx, { gateMode: 'enforce' })
  const agent = makeAgent()
  const write = { name: 'write', agent, arguments: {} }
  const pending = host.call('tools/pre-execute', write)
  await new Promise((resolve) => setImmediate(resolve))
  await host.tools.get('prework_plan').execute({ summary: '同一个回合的新计划' }, { agent })
  resolveApproval('allowed-once')
  const decision = await pending
  assert.equal(decision.kind, 'deny', 'old approval must not unlock the new plan')
  assert.ok(decision.reason.includes('旧批准已失效'))
})

check('approval policy never follows gateMode', async () => {
  const promptFirst = makeHost({ policy: 'never' })
  apply(promptFirst.ctx, {})
  const agent = makeAgent()
  const decision = await promptFirst.call('tools/pre-execute', { name: 'write', agent, arguments: {} })
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(promptFirst.approvalRequests.length, 0)

  const enforce = makeHost({ policy: 'never' })
  apply(enforce.ctx, { gateMode: 'enforce' })
  const denied = await enforce.call('tools/pre-execute', { name: 'write', agent: makeAgent(), arguments: {} })
  assert.equal(denied.kind, 'deny')
  assert.ok(denied.reason.includes('never'))
})

check('no approval service fails open in prompt-first and closed in enforce', async () => {
  const open = makeHost({ withApproval: false })
  apply(open.ctx, {})
  const openDecision = await open.call('tools/pre-execute', { name: 'write', agent: makeAgent(), arguments: {} })
  assert.deepEqual(openDecision, { kind: 'allow' })

  const closed = makeHost({ withApproval: false })
  apply(closed.ctx, { gateMode: 'enforce' })
  const closedDecision = await closed.call('tools/pre-execute', { name: 'write', agent: makeAgent(), arguments: {} })
  assert.equal(closedDecision.kind, 'deny')
  assert.ok(closedDecision.reason.includes('审批通道不可用'))

  const noAgent = makeHost()
  apply(noAgent.ctx, { gateMode: 'enforce' })
  const noAgentDecision = await noAgent.call('tools/pre-execute', { name: 'write', arguments: {} })
  assert.equal(noAgentDecision.kind, 'deny')
  assert.ok(noAgentDecision.reason.includes('Agent 上下文'))
})

check('rejected and cancelled approvals do not open the gate', async () => {
  const rejected = makeHost({ approval: 'rejected' })
  apply(rejected.ctx, {})
  const denied = await rejected.call('tools/pre-execute', { name: 'edit', agent: makeAgent(), arguments: {} })
  assert.equal(denied.kind, 'deny')
  assert.ok(denied.reason.includes('没有批准'))

  const cancelled = makeHost({ approval: 'cancelled' })
  apply(cancelled.ctx, {})
  const cancelledDecision = await cancelled.call('tools/pre-execute', { name: 'edit', agent: makeAgent(), arguments: {} })
  assert.deepEqual(cancelledDecision, { kind: 'cancel' })
})

check('read-only shell commands bypass while side-effecting commands are gated', async () => {
  assert.equal(isReadOnlyShell({ command: 'git status --short' }), true)
  assert.equal(isReadOnlyShell({ command: 'git branch --show-current' }), true)
  assert.equal(isReadOnlyShell({ command: 'ls -la' }), true)
  assert.equal(isReadOnlyShell({ command: 'Get-Content README.md' }), true)
  assert.equal(isReadOnlyShell({ command: 'git diff --output=trace.diff' }), false)
  assert.equal(isReadOnlyShell({ command: 'git diff --output trace.diff' }), false)
  assert.equal(isReadOnlyShell({ command: 'rm -rf build' }), false)
  assert.equal(isReadOnlyShell({ command: 'echo hi > note.txt' }), false)
  assert.equal(isReadOnlyShell({ script_path: 'build.sh', command: '' }), false)

  const host = makeHost()
  apply(host.ctx, {})
  const agent = makeAgent()
  await host.call('tools/pre-execute', { name: 'ops_bash', agent, arguments: { command: 'git status --short' } })
  assert.equal(host.approvalRequests.length, 0)
  await host.call('tools/pre-execute', { name: 'ops_bash', agent, arguments: { command: 'rm -rf build' } })
  assert.equal(host.approvalRequests.length, 1)
})

check('cleanup only auto-removes files explicitly created in temp directories', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pg-test-'))
  const tempFile = path.join(temp, 'scratch.tmp')
  const backupFile = path.join(temp, 'index.js.bak-20261118')
  const notesFile = path.join(temp, 'notes.md')
  writeFileSync(tempFile, 'x')
  writeFileSync(backupFile, 'x')
  writeFileSync(notesFile, 'x')
  try {
    assert.equal(classify(tempFile, { kind: 'created' }, new Set()).grade, 'auto')
    assert.equal(classify(tempFile, undefined, new Set()).grade, 'ask')
    assert.equal(classify(tempFile, { kind: 'supplied', supplied: true }, new Set()).grade, 'ask')
    assert.equal(classify(backupFile, { kind: 'created' }, new Set()).grade, 'ask')
    assert.equal(classify(tempFile, { kind: 'created' }, new Set([tempFile])).grade, 'protect')

    const workspaceProbe = path.join(process.cwd(), 'test', '.probe-workspace.md')
    writeFileSync(workspaceProbe, 'x')
    try {
      assert.equal(classify(workspaceProbe, { kind: 'created' }, new Set()).grade, 'ask')
      assert.equal(classify(workspaceProbe, { kind: 'modified' }, new Set()).grade, 'ask')
    } finally {
      rmSync(workspaceProbe, { force: true })
    }
    assert.equal(classify('.git/config', undefined, new Set()).grade, 'protect')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

check('cleanup dry-run reports supplied paths without deleting them', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pg-test-'))
  const file = path.join(temp, 'leftover.log')
  writeFileSync(file, 'x')
  const registry = createRegistry()
  const agent = makeAgent()
  const tool = createCleanupTool(registry)
  try {
    const value = await tool.execute({ dryRun: true, paths: [file] }, { agent })
    assert.equal(value.deleted.length, 0)
    assert.equal(value.scanned, 1)
    assert.ok(value.kept.some((item) => item.reason.includes('调用方补充')))
    assert.ok(existsSync(file), 'dry run must not delete')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

check('cleanup removes a created temp file for real and reports it', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pg-test-'))
  const file = path.join(temp, 'build.cache.tmp')
  writeFileSync(file, 'x')
  const registry = createRegistry()
  const agent = makeAgent()
  registry.record(agent, file, 'write', 'created')
  const tool = createCleanupTool(registry)
  try {
    const value = await tool.execute({}, { agent })
    assert.deepEqual(value.deleted, [file])
    assert.equal(existsSync(file), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

check('present marks a deliverable and cleanup will not touch it', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pg-test-'))
  const deliverable = path.join(temp, 'plugin.zip')
  writeFileSync(deliverable, 'x')
  const agent = makeAgent()
  try {
    const writeExec = { name: 'write', agent, arguments: { path: deliverable } }
    const presentExec = { name: 'present', agent, arguments: { files: [deliverable] } }
    await host.call('tools/pre-execute', writeExec)
    await host.call('tools/post-execute', writeExec, {})
    await host.call('tools/post-execute', presentExec, {})
    const value = await host.tools.get('postwork_cleanup').execute({}, { agent })
    assert.deepEqual(value.deleted, [])
    assert.ok(value.kept.some((item) => item.reason === '交付物'))
    assert.ok(existsSync(deliverable))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

check('successful writes are tracked and failed writes are not', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pg-test-'))
  const created = path.join(temp, 'new.tmp')
  const failed = path.join(temp, 'failed.tmp')
  const agent = makeAgent()
  try {
    const createdExec = { name: 'write', agent, arguments: { path: created } }
    const failedExec = { name: 'write', agent, arguments: { path: failed } }
    await host.call('tools/pre-execute', createdExec)
    writeFileSync(created, 'x')
    await host.call('tools/post-execute', createdExec, { isError: false })

    await host.call('tools/pre-execute', failedExec)
    await host.call('tools/post-execute', failedExec, { isError: true })

    const value = await host.tools.get('postwork_cleanup').execute({ dryRun: true }, { agent })
    assert.ok(value.kept.some((item) => item.path === created && item.reason.includes('dryRun')))
    assert.ok(!value.kept.some((item) => item.path === failed))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

check('move tracking records only the destination, not the source', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pg-test-'))
  const source = path.join(temp, 'source.txt')
  const destination = path.join(temp, 'destination.txt')
  writeFileSync(source, 'x')
  const agent = makeAgent()
  try {
    const moveExec = {
      name: 'move_file',
      agent,
      arguments: { source, destination },
    }
    await host.call('tools/pre-execute', moveExec)
    writeFileSync(destination, 'x')
    await host.call('tools/post-execute', moveExec, { isError: false })

    const value = await host.tools.get('postwork_cleanup').execute({ dryRun: true }, { agent })
    assert.ok(value.kept.some((item) => item.path === destination && item.reason.includes('dryRun')))
    assert.ok(!value.kept.some((item) => item.path === source))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

check('postwork_cleanup dryRun is free but a real cleanup is gated', async () => {
  const host = makeHost({ approval: 'rejected' })
  apply(host.ctx, {})
  const agent = makeAgent()
  const dry = await host.call('tools/pre-execute', {
    name: 'postwork_cleanup',
    agent,
    arguments: { dryRun: true },
  })
  assert.deepEqual(dry, { kind: 'allow' })
  assert.equal(host.approvalRequests.length, 0)
  const real = await host.call('tools/pre-execute', {
    name: 'postwork_cleanup',
    agent,
    arguments: {},
  })
  assert.equal(real.kind, 'deny')
  assert.equal(host.approvalRequests.length, 1)
})

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    process.stdout.write(`ok   ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}\n`)
  }
}
process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`)
if (failed > 0) process.exitCode = 1
