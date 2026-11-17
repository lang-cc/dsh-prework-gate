/**
 * lib/cleanup.js — postwork cleanup.
 *
 * Two jobs:
 * 1. Remember what this session produced: write-ish tool calls register their
 *    target paths, `present` registers deliverables.
 * 2. Offer a `postwork_cleanup` tool that removes the disposable part of that
 *    list — temp files, logs, build leftovers — to the Recycle Bin, while
 *    refusing to touch deliverables, user data, `.git`, junctions and backups.
 *
 * The tool is model-invoked (the prompt asks for it at hand-off). Nothing is
 * deleted in the background: every removal is reported with its path.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Argument keys that carry a filesystem path in the shipped tools. */
const PATH_KEYS = new Set([
  'path', 'paths', 'file_path', 'filepath', 'files', 'target', 'targets',
  'dest', 'destination', 'source', 'sources', 'from', 'to', 'dir', 'directory',
])

/** Tool names whose arguments describe files this session touched. */
const WRITE_TOOL = /(write|edit|create|save|patch|replace|append|mkdir|move|copy|delete|remove|present)/i

/** Disposable name shapes: safe to remove without asking. */
const JUNK_NAME = /(\.tmp|\.temp|~|\.swp|\.swo|\.DS_Store|Thumbs\.db|\.pyc)$/i

/** Backup shapes: never removed automatically, always reported. */
const BACKUP_NAME = /(\.bak|\.old|\.orig|backup)/i

/** Roots that must never be touched, whatever the registry says. */
const PROTECTED_ROOTS = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
  '/usr', '/etc', '/bin', '/sbin', '/System', '/Library',
]

const MAX_AUTO_BYTES = 200 * 1024 * 1024
const MAX_DELETE_PER_RUN = 50

/** Normalize one candidate path; undefined when it is not usable. */
function normalizePath(candidate) {
  if (typeof candidate !== 'string') return undefined
  const trimmed = candidate.trim()
  if (trimmed.length === 0 || trimmed.includes('\0')) return undefined
  return path.resolve(trimmed)
}

/** Pull every path-looking argument out of one tool call. */
function pathsFromArguments(args) {
  const found = []
  if (args === null || typeof args !== 'object') return found
  for (const [key, value] of Object.entries(args)) {
    if (!PATH_KEYS.has(key.toLowerCase())) continue
    if (typeof value === 'string') found.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') found.push(item)
    } else if (value !== null && typeof value === 'object' && typeof value.path === 'string') {
      found.push(value.path)
    }
  }
  return found
}

/** Whether `target` sits inside `root` (case-insensitive on Windows). */
function isInside(target, root) {
  const lower = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
  const normalizedTarget = lower(target)
  const normalizedRoot = lower(root)
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(prefix)
}

/**
 * Session registry of produced paths, one bucket per agent.
 * @returns {{ record, deliverable, for }}
 */
export function createRegistry() {
  const perAgent = new WeakMap()
  const fallback = { files: new Map(), deliverables: new Set() }
  const bucket = (agent) => {
    if (agent === undefined || agent === null || typeof agent !== 'object') return fallback
    let state = perAgent.get(agent)
    if (state === undefined) {
      state = { files: new Map(), deliverables: new Set() }
      perAgent.set(agent, state)
    }
    return state
  }
  return {
    record(agent, filePath, via) {
      const resolved = normalizePath(filePath)
      if (resolved === undefined) return
      const state = bucket(agent)
      if (!state.files.has(resolved)) state.files.set(resolved, { via, at: Date.now() })
    },
    deliverable(agent, filePath) {
      const resolved = normalizePath(filePath)
      if (resolved === undefined) return
      bucket(agent).deliverables.add(resolved)
    },
    for(agent) {
      const state = bucket(agent)
      return { files: new Map(state.files), deliverables: new Set(state.deliverables) }
    },
  }
}

/** Classify one candidate as auto-removable, needs-asking, or protected. */
export function classify(candidate, meta, deliverables) {
  const target = path.resolve(candidate)
  for (const deliverable of deliverables) {
    if (isInside(target, deliverable)) return { grade: 'protect', reason: '交付物' }
  }
  for (const root of PROTECTED_ROOTS) {
    if (isInside(target, path.resolve(root))) return { grade: 'protect', reason: '系统目录' }
  }
  if (isInside(target, path.join(os.homedir(), '.dsh'))) return { grade: 'protect', reason: '配置与记忆库' }
  if (/[\\/]\.git([\\/]|$)/.test(target)) return { grade: 'protect', reason: 'Git 仓库' }

  let stats
  try {
    stats = lstatSync(target, { throwIfNoEntry: false })
  } catch {
    return { grade: 'protect', reason: '无法读取' }
  }
  if (stats === undefined) return { grade: 'protect', reason: '已不存在' }
  if (stats.isSymbolicLink()) return { grade: 'protect', reason: '符号链接或 junction' }
  if (stats.isDirectory()) return { grade: 'ask', reason: '目录不自动删除' }
  if (BACKUP_NAME.test(path.basename(target))) return { grade: 'ask', reason: '备份文件，验收前先留着' }
  if (stats.size >= MAX_AUTO_BYTES) return { grade: 'ask', reason: '超过 200MB，先确认' }

  const tempRoots = [os.tmpdir(), process.env.TEMP, process.env.TMP]
    .filter((root) => typeof root === 'string' && root.length > 0)
  if (tempRoots.some((root) => isInside(target, path.resolve(root)))) return { grade: 'auto', reason: '临时目录产物' }
  if (JUNK_NAME.test(path.basename(target))) return { grade: 'auto', reason: '临时文件' }
  if (meta !== undefined && typeof meta.via === 'string' && meta.via.length > 0) {
    return { grade: 'ask', reason: '工作区文件，先确认' }
  }
  return { grade: 'ask', reason: '来源不明，先确认' }
}

/** Send one batch to the Windows Recycle Bin. */
function recycleWindows(paths) {
  const quoted = paths.map((item) => `'${item.replace(/'/g, "''")}'`).join(',')
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$p = @(${quoted})`,
    'for ($i = 0; $i -lt $p.Count; $i++) {',
    '  try {',
    '    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p[$i], [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
    '    Write-Output "OK $i"',
    '  } catch { Write-Output "ERR $i" }',
    '}',
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  })
  const output = typeof result.stdout === 'string' ? result.stdout : ''
  const status = new Map()
  for (const line of output.split(/\r?\n/)) {
    const match = /^(OK|ERR)\s+(\d+)$/.exec(line.trim())
    if (match !== null) status.set(Number(match[2]), match[1] === 'OK')
  }
  return paths.map((item, index) => ({
    path: item,
    ok: status.get(index) === true,
    reason: status.get(index) === false ? '回收站拒绝' : '未返回结果',
  }))
}

/** Move one file into a dated trash folder (fallback / non-Windows path). */
function moveToTrash(filePath, trashRoot, index) {
  const destination = path.join(trashRoot, `${index}-${path.basename(filePath)}`)
  try {
    if (!existsSync(filePath)) return { path: filePath, ok: false, reason: '已不存在' }
    if (process.platform === 'win32') {
      const moved = spawnSync('cmd', ['/c', 'move', filePath, destination], { windowsHide: true })
      return moved.status === 0
        ? { path: filePath, ok: true, reason: '' }
        : { path: filePath, ok: false, reason: '移动失败' }
    }
    const rename = spawnSync('mv', [filePath, destination], { windowsHide: true })
    return rename.status === 0
      ? { path: filePath, ok: true, reason: '' }
      : { path: filePath, ok: false, reason: '移动失败' }
  } catch (error) {
    return { path: filePath, ok: false, reason: String(error) }
  }
}

/**
 * Remove files, preferring the Recycle Bin and falling back to a trash folder.
 * @returns {{ deleted: string[], failed: {path: string, reason: string}[] }}
 */
export function recycle(paths) {
  const deleted = []
  const failed = []
  if (paths.length === 0) return { deleted, failed }
  let remaining = paths

  if (process.platform === 'win32') {
    const attempts = recycleWindows(remaining)
    for (const attempt of attempts) {
      if (attempt.ok) deleted.push(attempt.path)
    }
    remaining = attempts.filter((attempt) => !attempt.ok).map((attempt) => attempt.path)
  }
  if (remaining.length > 0) {
    const trashRoot = path.join(os.tmpdir(), 'prework-gate-trash', String(Date.now()))
    try {
      spawnSync('mkdir', ['-p', trashRoot], { windowsHide: true })
    } catch {
      // mkdir -p is best effort; moveToTrash reports per-file failures.
    }
    remaining.forEach((item, index) => {
      const attempt = moveToTrash(item, trashRoot, index)
      if (attempt.ok) deleted.push(attempt.path)
      else failed.push({ path: attempt.path, reason: attempt.reason })
    })
  }
  return { deleted, failed }
}

const PAIR = {
  type: 'object',
  properties: { path: { type: 'string' }, reason: { type: 'string' } },
  required: ['path', 'reason'],
  additionalProperties: false,
}

const CLEANUP_OUTPUT = {
  type: 'object',
  properties: {
    deleted: { type: 'array', items: { type: 'string' }, description: '已删除的路径' },
    failed: { type: 'array', items: PAIR, description: '删除失败及原因' },
    kept: { type: 'array', items: PAIR, description: '保留的路径及原因' },
    scanned: { type: 'integer', description: '参与判断的路径数' },
    note: { type: 'string', description: '补充说明' },
  },
  required: ['deleted', 'failed', 'kept', 'scanned', 'note'],
  additionalProperties: false,
}

/**
 * Build the `postwork_cleanup` tool definition.
 * @param registry - Session path registry.
 * @param options - { maxDelete }.
 * @returns Raw tool definition for `ctx.tools.register`.
 */
export function createCleanupTool(registry, options = {}) {
  const maxDelete = Number.isInteger(options.maxDelete) && options.maxDelete > 0
    ? Math.min(options.maxDelete, MAX_DELETE_PER_RUN)
    : MAX_DELETE_PER_RUN
  return {
    name: 'postwork_cleanup',
    description: '任务交付后的清道夫：把本会话产生的临时文件、日志、构建残留移入回收站，并列出不能自动删除的东西（交付物、备份、工作区文件）。只删临时产物，不碰交付物与用户数据；dryRun 只扫描不删。',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '额外候选路径（本会话登记的路径会自动参与判断）' },
        dryRun: { type: 'boolean', description: '只扫描并报告，不删除任何文件' },
      },
      additionalProperties: false,
    },
    output: {
      schema: CLEANUP_OUTPUT,
      render(args, value) {
        const lines = [`扫描 ${value.scanned} 个路径`]
        if (value.deleted.length > 0) {
          lines.push(`已移入回收站 ${value.deleted.length} 个：`)
          for (const item of value.deleted.slice(0, 20)) lines.push(`- ${item}`)
        }
        if (value.failed.length > 0) {
          lines.push(`删除失败 ${value.failed.length} 个：`)
          for (const item of value.failed.slice(0, 10)) lines.push(`- ${item.path}（${item.reason}）`)
        }
        if (value.kept.length > 0) {
          lines.push(`保留 ${value.kept.length} 个：`)
          for (const item of value.kept.slice(0, 20)) lines.push(`- ${item.path}（${item.reason}）`)
        }
        if (value.note.length > 0) lines.push(value.note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const dryRun = args?.dryRun === true
      const extra = Array.isArray(args?.paths) ? args.paths : []
      const state = registry.for(exec?.agent)
      const candidates = new Map()
      for (const item of [...state.files.keys(), ...extra]) {
        const resolved = normalizePath(item)
        if (resolved !== undefined) candidates.set(resolved, state.files.get(resolved))
      }

      const auto = []
      const kept = []
      for (const [target, meta] of candidates) {
        const verdict = classify(target, meta, state.deliverables)
        if (verdict.grade === 'auto') auto.push(target)
        else kept.push({ path: target, reason: verdict.reason })
      }

      let overflow = 0
      if (auto.length > maxDelete) {
        overflow = auto.length - maxDelete
        for (const item of auto.slice(maxDelete)) kept.push({ path: item, reason: `单次上限 ${maxDelete}，下次再清` })
        auto.length = maxDelete
      }

      if (dryRun) {
        return {
          deleted: [],
          failed: [],
          kept: [...kept, ...auto.map((item) => ({ path: item, reason: '将被删除（dryRun）' }))],
          scanned: candidates.size,
          note: `dryRun：本可删除 ${auto.length} 个临时产物。`,
        }
      }

      const outcome = auto.length === 0 ? { deleted: [], failed: [] } : recycle(auto)
      const missing = [...state.deliverables].filter((item) => !existsSync(item))
      const noteParts = []
      if (overflow > 0) noteParts.push(`另有 ${overflow} 个临时产物超过单次上限，可再跑一次。`)
      if (missing.length > 0) noteParts.push(`注意：${missing.length} 个登记过的交付物当前不存在，请复核：${missing.slice(0, 5).join('、')}`)
      return {
        deleted: outcome.deleted,
        failed: outcome.failed,
        kept,
        scanned: candidates.size,
        note: noteParts.join(' '),
      }
    },
  }
}

/** Feed the registry from `tools/post-execute`; never alters the result. */
export function trackToolCalls(ctx, registry) {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      if (exec !== undefined && typeof exec.name === 'string') {
        const isPresent = exec.name === 'present'
        if (isPresent || WRITE_TOOL.test(exec.name)) {
          for (const item of pathsFromArguments(exec.arguments)) {
            if (isPresent) registry.deliverable(exec.agent, item)
            else registry.record(exec.agent, item, exec.name)
          }
        }
      }
    } catch {
      // Tracking is best effort: an odd argument shape must not break a tool call.
    }
    return next()
  })
}
