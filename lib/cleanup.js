/**
 * lib/cleanup.js — postwork cleanup.
 *
 * Two jobs:
 * 1. Remember what this session actually created: write tools record target
 *    paths after a successful result, and `present` registers deliverables.
 * 2. Offer a `postwork_cleanup` tool that removes only created temp files —
 *    preferring the Windows Recycle Bin — while refusing to touch modified
 *    files, deliverables, user data, `.git`, junctions and backups.
 *
 * The tool is model-invoked (the prompt asks for it at hand-off). Nothing is
 * deleted in the background: every removal is reported with its path.
 */

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

/** Argument keys that carry an output path in the shipped write tools. */
const PATH_KEYS = new Set([
  'path', 'paths', 'file_path', 'filepath', 'files', 'target', 'targets',
  'dest', 'destination', 'dir', 'directory',
])

/** Exact write-ish tools; do not infer from arbitrary substrings of names. */
const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'apply_patch',
  'str_replace',
  'str_replace_editor',
  'multiedit',
  'notebook_edit',
  'create_file',
])

const MOVE_TOOLS = new Set(['move_file', 'move', 'rename'])
const DELETE_TOOLS = new Set(['delete_file', 'delete', 'remove'])

/** Disposable name shapes. Only used after the path is confirmed created. */
const JUNK_NAME = /(\.tmp|\.temp|~|\.swp|\.swo|\.DS_Store|Thumbs\.db|\.pyc)$/i

/** Backup shapes: never removed automatically, always reported. */
const BACKUP_NAME = /(\.bak|\.old|\.orig|backup)/i

const SYSTEM_ROOTS = [
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
  '/usr', '/etc', '/bin', '/sbin', '/System', '/Library',
]

const USER_DATA_ROOTS = [
  'Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'OneDrive',
].map((name) => path.join(os.homedir(), name))

const MAX_AUTO_BYTES = 200 * 1024 * 1024
const MAX_DELETE_PER_RUN = 50

/** Normalize one candidate path; undefined when it is not usable. */
function normalizePath(candidate, baseDir) {
  if (typeof candidate !== 'string') return undefined
  const trimmed = candidate.trim()
  if (trimmed.length === 0 || /[\0\r\n]/.test(trimmed)) return undefined
  try {
    return path.resolve(typeof baseDir === 'string' && path.isAbsolute(baseDir) ? baseDir : process.cwd(), trimmed)
  } catch {
    return undefined
  }
}

/**
 * Read the session's authoritative working directory when the Host exposes
 * the optional service. Tool paths may be relative; the process cwd is not a
 * safe substitute for the session workspace.
 */
export function sessionCwd(ctx, agent) {
  try {
    const cwd = typeof ctx.get === 'function'
      ? ctx.get('workingDirectory')?.get?.(agent?.session)
      : undefined
    return typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : undefined
  } catch {
    return undefined
  }
}

/** Pull every output-looking path out of one tool call. */
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

/** Extract paths from apply_patch's textual patch format. */
function pathsFromPatch(args) {
  const patch = typeof args?.patch === 'string'
    ? args.patch
    : typeof args?.input === 'string' ? args.input : ''
  if (patch.length === 0) return []
  const found = []
  const fileLine = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm
  let match
  while ((match = fileLine.exec(patch)) !== null) {
    const value = match[1].trim()
    if (value.length > 0) found.push(value)
  }
  return found
}

/** Output paths a tool may have created or modified. Delete tools never do. */
function touchedPaths(exec) {
  if (exec === undefined || typeof exec.name !== 'string') return []
  if (DELETE_TOOLS.has(exec.name)) return []
  if (exec.name === 'present') return pathsFromArguments(exec.arguments)
  if (MOVE_TOOLS.has(exec.name)) {
    const args = exec.arguments
    const destinations = []
    if (typeof args?.destination === 'string') destinations.push(args.destination)
    if (typeof args?.dest === 'string') destinations.push(args.dest)
    if (typeof args?.to === 'string') destinations.push(args.to)
    return destinations
  }
  if (!WRITE_TOOLS.has(exec.name)) return []
  if (exec.name === 'apply_patch') {
    const patchPaths = pathsFromPatch(exec.arguments)
    return patchPaths.length > 0 ? patchPaths : pathsFromArguments(exec.arguments)
  }
  return pathsFromArguments(exec.arguments)
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
    /**
     * Record a path touched by this session.
     * Defaults to `modified`; callers must explicitly mark a path `created`.
     */
    record(agent, filePath, via, kind = 'modified', baseDir) {
      const resolved = normalizePath(filePath, baseDir)
      if (resolved === undefined) return
      const state = bucket(agent)
      const previous = state.files.get(resolved)
      // A later edit does not erase the fact that this session created the file.
      if (previous?.kind === 'created') return
      state.files.set(resolved, { via, kind: kind === 'created' ? 'created' : 'modified', at: Date.now() })
    },
    deliverable(agent, filePath, baseDir) {
      const resolved = normalizePath(filePath, baseDir)
      if (resolved === undefined) return
      bucket(agent).deliverables.add(resolved)
    },
    for(agent) {
      const state = bucket(agent)
      return { files: new Map(state.files), deliverables: new Set(state.deliverables) }
    },
  }
}

/** All roots that are never cleanup candidates. */
function protectedRoots() {
  return [...SYSTEM_ROOTS, ...USER_DATA_ROOTS]
}

/**
 * Classify one candidate as auto-removable, needs-asking, or protected.
 *
 * A file is auto-removable only when the registry explicitly marks it as
 * created by this session and it lives under the OS temp root. Everything
 * ambiguous is reported, not deleted.
 */
export function classify(candidate, meta, deliverables) {
  const target = path.resolve(candidate)
  for (const deliverable of deliverables) {
    if (isInside(target, deliverable)) return { grade: 'protect', reason: '交付物' }
  }
  for (const root of protectedRoots()) {
    if (isInside(target, path.resolve(root))) return { grade: 'protect', reason: '用户数据或系统目录' }
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
  if (meta?.supplied === true) return { grade: 'ask', reason: '调用方补充的候选路径，先确认' }

  const tempRoots = [os.tmpdir(), process.env.TEMP, process.env.TMP]
    .filter((root) => typeof root === 'string' && root.length > 0)
  const inTemp = tempRoots.some((root) => isInside(target, path.resolve(root)))
  const created = meta?.kind === 'created'

  if (inTemp) {
    return created
      ? { grade: 'auto', reason: '本轮创建的临时目录产物' }
      : { grade: 'ask', reason: '临时目录中的来源不明文件' }
  }
  if (created && JUNK_NAME.test(path.basename(target))) {
    return { grade: 'ask', reason: '工作区临时文件，先确认' }
  }
  if (created) return { grade: 'ask', reason: '本轮创建的工作区文件，先确认是否为交付物' }
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
    '    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p[$i], [Microsoft.VisualBasic.FileIO.UIOption]::NoUI, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)',
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
  if (result.error === undefined && result.status === 0) {
    for (const line of output.split(/\r?\n/)) {
      const match = /^(OK|ERR)\s+(\d+)$/.exec(line.trim())
      if (match !== null) status.set(Number(match[2]), match[1] === 'OK')
    }
  }
  return paths.map((item, index) => ({
    path: item,
    ok: status.get(index) === true,
    reason: result.error !== undefined
      ? String(result.error)
      : result.status !== 0 ? `PowerShell 退出码 ${String(result.status)}`
        : status.get(index) === false ? '回收站拒绝' : '未返回结果',
  }))
}

/** Move one file into a dated trash folder (fallback / non-Windows path). */
function moveToTrash(filePath, trashRoot, index) {
  const destination = path.join(trashRoot, `${index}-${path.basename(filePath)}`)
  try {
    if (!existsSync(filePath)) return { path: filePath, ok: false, reason: '已不存在' }
    mkdirSync(trashRoot, { recursive: true })
    try {
      renameSync(filePath, destination)
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
      copyFileSync(filePath, destination)
      unlinkSync(filePath)
    }
    return { path: filePath, ok: true, reason: '' }
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
    const trashRoot = path.join(os.tmpdir(), 'prework-gate-trash', `${Date.now()}-${randomUUID().slice(0, 8)}`)
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
    deleted: { type: 'array', items: { type: 'string' }, description: '已移入回收站的路径' },
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
    description: '任务交付后的清道夫：只把本会话明确创建、且位于临时目录中的文件移入回收站；工作区文件、修改过的文件、调用方补充路径、交付物与备份都只报告不删除。dryRun 只扫描。',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '额外候选路径；只会报告，不会自动删除' },
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
      const cwd = typeof options.cwdFor === 'function' ? options.cwdFor(exec?.agent) : undefined
      const state = registry.for(exec?.agent)
      const candidates = new Map()
      for (const item of state.files.keys()) {
        const resolved = normalizePath(item, cwd)
        if (resolved !== undefined) candidates.set(resolved, state.files.get(resolved))
      }
      for (const item of extra) {
        const resolved = normalizePath(item, cwd)
        if (resolved !== undefined && !candidates.has(resolved)) {
          candidates.set(resolved, { kind: 'supplied', supplied: true })
        }
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
          note: `dryRun：本可删除 ${auto.length} 个本轮创建的临时产物。`,
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

/** Feed the registry from tool execution events; never alters the result. */
export function trackToolCalls(ctx, registry) {
  const observations = new WeakMap()

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (exec !== undefined) {
        const cwd = sessionCwd(ctx, exec.agent)
        const snapshot = touchedPaths(exec)
          .map((item) => normalizePath(item, cwd))
          .filter((item) => item !== undefined)
          .map((item) => ({ path: item, preexisting: existsSync(item) }))
        if (snapshot.length > 0) observations.set(exec, snapshot)
      }
    } catch {
      // Observation is best effort and must never block a tool call.
    }
    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      if (exec !== undefined && result?.isError !== true) {
        const isPresent = exec.name === 'present'
        if (isPresent) {
          const cwd = sessionCwd(ctx, exec.agent)
          for (const item of touchedPaths(exec)) registry.deliverable(exec.agent, item, cwd)
        } else {
          const snapshot = observations.get(exec) ?? []
          for (const item of snapshot) {
            if (!existsSync(item.path)) continue
            registry.record(
              exec.agent,
              item.path,
              exec.name,
              item.preexisting ? 'modified' : 'created',
            )
          }
        }
      }
    } catch {
      // Tracking is best effort: an odd argument shape must not break a tool call.
    }
    return next()
  })
}
