/**
 * test/run.mjs — dependency-free smoke test for the Host half.
 *
 * Run with `node test/run.mjs`. It builds a fake Host context (no DSH install
 * needed), exercises the prompt section, both tools, the brake, and the cleanup
 * classifier, then prints one line per check.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'
import { createRegistry, createCleanupTool, classify } from '../lib/cleanup.js'

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
    else for (const name of node.required) if (node.properties === undefined || !Object.hasOwn(node.properties, name)) {
      problems.push(`${label}: required "${name}" is not declared`)
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
  const approvalService = {
    request: async (request) => {
      approvalRequests.push(request)
      return approval
    },
    policyFor: () => policy,
  }
  const ctx = {
    systemPrompt: { section: (section) => sections.push(section) },
    tools: { register: (definition) => { tools.set(definition.name, definition) } },
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
  return { ctx, sections, tools, approvalRequests, call }
}

check('section text carries all four rule blocks', () => {
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

check('optional blocks and extra rules', () => {
  const host = makeHost()
  apply(host.ctx, { grill: false, gate: false, cleanup: false, extraRules: ['删除前先列绝对路径', ''] })
  const text = host.sections[0].text
  assert.ok(!text.includes('一轮问完'))
  assert.ok(!text.includes('硬闸门'))
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
  const agent = {}
  const value = await plan.execute({ summary: '加清理工具', steps: ['写 lib/cleanup.js', '装回 profile'] }, { agent })
  assert.equal(value.recorded, true)
  assert.equal(value.gate, 'closed')
  assert.ok(value.plan.includes('1. 写 lib/cleanup.js'))
  const rendered = plan.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
})

check('brake asks once, then lets the task through', async () => {
  const host = makeHost({ approval: 'allowed-once' })
  apply(host.ctx, {})
  const agent = {}
  const write = { name: 'write', agent, arguments: { path: 'a.txt' } }
  assert.deepEqual(await host.call('tools/pre-execute', write), { kind: 'allow' })
  assert.equal(host.approvalRequests.length, 1)
  assert.ok(host.approvalRequests[0].reason.includes('开工闸门'))
  assert.deepEqual(await host.call('tools/pre-execute', { ...write, arguments: { path: 'b.txt' } }), { kind: 'allow' })
  assert.equal(host.approvalRequests.length, 1, 'second write must not ask again')
})

check('non-gated tools never ask', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const agent = {}
  for (const name of ['todo_write', 'read', 'ops_bash', 'prework_plan', 'postwork_cleanup', 'plugin_manager']) {
    assert.deepEqual(await host.call('tools/pre-execute', { name, agent, arguments: {} }), { kind: 'allow' })
  }
  assert.equal(host.approvalRequests.length, 0)
})

check('approval policy never lifts the brake instead of denying everything', async () => {
  const host = makeHost({ policy: 'never' })
  apply(host.ctx, {})
  const agent = { session: {} }
  const decision = await host.call('tools/pre-execute', { name: 'write', agent, arguments: {} })
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(host.approvalRequests.length, 0, 'no dialog under policy never')
  // The same session keeps running without a second policy probe storm.
  await host.call('tools/pre-execute', { name: 'edit', agent, arguments: {} })
  assert.equal(host.approvalRequests.length, 0)
})

check('no approval service means fail open, not a stuck profile', async () => {
  const host = makeHost({ withApproval: false })
  apply(host.ctx, {})
  const decision = await host.call('tools/pre-execute', { name: 'write', agent: {}, arguments: {} })
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(host.approvalRequests.length, 0)
})

check('rejected approval turns into a denial', async () => {
  const host = makeHost({ approval: 'rejected' })
  apply(host.ctx, {})
  const decision = await host.call('tools/pre-execute', { name: 'edit', agent: {}, arguments: {} })
  assert.equal(decision.kind, 'deny')
  assert.ok(decision.reason.includes('没有批准'))
})

check('plan tool re-arms the brake for the next task', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const agent = {}
  const write = { name: 'write', agent, arguments: {} }
  await host.call('tools/pre-execute', write)
  assert.equal(host.approvalRequests.length, 1)
  await host.tools.get('prework_plan').execute({ summary: '第二个任务' }, { agent })
  await host.call('tools/pre-execute', write)
  assert.equal(host.approvalRequests.length, 2, 'a new plan must re-open the gate')
})

check('cleanup classifies temp, backups, deliverables and junk correctly', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pg-test-'))
  const tempFile = path.join(temp, 'scratch.tmp')
  const backupFile = path.join(temp, 'index.js.bak-20261117')
  const notesFile = path.join(temp, 'notes.md')
  writeFileSync(tempFile, 'x')
  writeFileSync(backupFile, 'x')
  writeFileSync(notesFile, 'x')
  try {
    assert.equal(classify(tempFile, undefined, new Set()).grade, 'auto')
    assert.equal(classify(backupFile, undefined, new Set()).reason, '备份文件，验收前先留着')
    assert.equal(classify(tempFile, undefined, new Set([tempFile])).grade, 'protect')
    // A file inside the temp root is disposable whatever its name.
    assert.equal(classify(notesFile, { via: 'write' }, new Set()).grade, 'auto')
    // A workspace file made by a write tool is not: it may be the deliverable.
    const workspaceProbe = path.join(process.cwd(), 'test', '.probe-workspace.md')
    writeFileSync(workspaceProbe, 'x')
    try {
      assert.equal(classify(workspaceProbe, { via: 'write' }, new Set()).grade, 'ask')
    } finally {
      rmSync(workspaceProbe, { force: true })
    }
    assert.equal(classify('.git/config', undefined, new Set()).grade, 'protect')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

check('cleanup tool dry-run reports without deleting', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pg-test-'))
  const file = path.join(temp, 'leftover.log')
  writeFileSync(file, 'x')
  const registry = createRegistry()
  const agent = {}
  registry.record(agent, file, 'write')
  const tool = createCleanupTool(registry)
  try {
    const value = await tool.execute({ dryRun: true, paths: [file] }, { agent })
    assert.equal(value.deleted.length, 0)
    assert.equal(value.scanned, 1)
    assert.ok(value.kept.some((item) => item.reason.includes('dryRun')))
    assert.ok(existsSync(file), 'dry run must not delete')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

check('cleanup tool removes a temp file for real', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pg-test-'))
  const file = path.join(temp, 'build.cache.tmp')
  writeFileSync(file, 'x')
  const registry = createRegistry()
  const agent = {}
  registry.record(agent, file, 'write')
  const tool = createCleanupTool(registry)
  try {
    const value = await tool.execute({}, { agent })
    assert.deepEqual(value.deleted, [file])
    assert.equal(existsSync(file), false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

check('present marks deliverables that cleanup will not touch', async () => {
  const host = makeHost()
  apply(host.ctx, {})
  const temp = mkdtempSync(path.join(os.tmpdir(), 'pg-test-'))
  const deliverable = path.join(temp, 'plugin.zip')
  writeFileSync(deliverable, 'x')
  const agent = {}
  try {
    await host.call('tools/post-execute', { name: 'write', agent, arguments: { path: deliverable } }, {})
    await host.call('tools/post-execute', { name: 'present', agent, arguments: { files: [deliverable] } }, {})
    const value = await host.tools.get('postwork_cleanup').execute({}, { agent })
    assert.deepEqual(value.deleted, [])
    assert.ok(value.kept.some((item) => item.reason === '交付物'))
    assert.ok(existsSync(deliverable))
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
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
