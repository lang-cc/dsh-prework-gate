/**
 * lib/gate.js — the hard half of the prework gate.
 *
 * The prompt section asks the model to plan first; this file makes the request
 * stick when the model skips it. `tools/pre-execute` is the pipeline's ordered
 * allow/deny/ask gate, so a write-ish tool call that arrives without an
 * approved plan is routed through the Host approval seam instead of touching
 * the disk.
 *
 * Design notes:
 * - Approval is per agent (one Cordis session) and per turn. The Host emits
 *   `session/event` with `turn/start`; that boundary closes every gate it owns.
 *   The model does not have to remember to call `prework_plan` between tasks.
 * - `prework_plan` arms the gate for the current turn. It does not identify new
 *   tasks by itself and cannot keep an old approval alive.
 * - The gate never invents its own dialog channel: it goes through
 *   `ctx.approval.request()`, which is a one-shot Host approval with audit.
 *   `gateMode: 'prompt-first'` fails open when that seam is unavailable;
 *   `gateMode: 'enforce'` fails closed instead.
 */

/** Tools that always run without asking, whatever the gate says. */
const ALWAYS_FREE = new Set(['prework_plan', 'todo_write', 'present'])

/**
 * Default brake list: tools that change the workspace or execute arbitrary
 * commands. `plugin_manager` stays out on purpose — it is the recovery path
 * that reloads or disables this very plugin, and gating it would leave no way
 * back when a gate misbehaves.
 *
 * `ops_bash` is included, but clearly read-only commands bypass the dialog
 * through `isReadOnlyShell` below. `postwork_cleanup` is included as well;
 * `dryRun: true` is the one explicit exemption.
 */
const DEFAULT_GATED = [
  'write',
  'edit',
  'apply_patch',
  'str_replace',
  'str_replace_editor',
  'multiedit',
  'notebook_edit',
  'create_file',
  'move_file',
  'delete_file',
  'ops_bash',
  'bash',
  'pwsh',
  'shell',
  'postwork_cleanup',
]

/** Commands whose complete invocation is known to be read-only. */
const SAFE_SHELL_COMMANDS = new Set([
  'pwd',
  'ls',
  'dir',
  'cat',
  'type',
  'head',
  'tail',
  'wc',
  'where',
  'which',
  'get-childitem',
  'get-content',
  'get-item',
  'get-command',
  'get-filehash',
  'test-path',
  'resolve-path',
  'select-string',
])

/** Git subcommands that do not write to the working tree by themselves. */
const SAFE_GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse'])

/** Shell operators that make a command too complex to classify safely. */
const OPAQUE_SHELL = /[\r\n;&|<>`]|\$\(|\$\{/

/** Git flags that can turn a read-only-looking command into a write. */
const UNSAFE_GIT_FLAG = /(^|\s)(--output(?:=|\s|$)|-o(?:=|\s|$)|--ext-diff\b|--textconv\b)/i

/**
 * Classify one `ops_bash` call without trying to be clever.
 *
 * This is deliberately a small allow-list. Anything ambiguous, compound, or
 * script-based is gated. The goal is not to understand every shell; it is to
 * avoid silently treating a write as read-only.
 *
 * @param {{ command?: unknown, script_path?: unknown }} args - shell arguments.
 * @returns {boolean} whether the invocation is safe to run without approval.
 */
export function isReadOnlyShell(args) {
  if (args === null || typeof args !== 'object') return false
  if (typeof args.script_path === 'string' && args.script_path.trim() !== '') return false
  if (typeof args.command !== 'string') return false
  const command = args.command.trim()
  if (command.length === 0 || OPAQUE_SHELL.test(command)) return false

  const words = command.split(/\s+/)
  const head = words[0].toLowerCase()

  if (head === 'git') {
    const subcommand = words[1]?.toLowerCase()
    if (!SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
      if (subcommand === 'branch') {
        return words.length === 3 && words[2].toLowerCase() === '--show-current'
      }
      if (subcommand === 'remote') {
        return words.length === 3 && words[2].toLowerCase() === '-v'
      }
      return false
    }
    return !UNSAFE_GIT_FLAG.test(command)
  }

  if (head === 'node' || head === 'npm' || head === 'python' || head === 'python3' || head === 'code') {
    return words.length === 2 && /^(?:--?v|--version)$/i.test(words[1])
  }

  return SAFE_SHELL_COMMANDS.has(head)
}

/**
 * Per-agent, per-turn gate state.
 * @param ctx - Host plugin context.
 * @param options - { gatedTools, approvalTtlMinutes, approval, gateMode, allowReadOnlyShell }.
 * @returns {{
 *   stateFor: (agent: object) => object | undefined,
 *   isGated: (name: string, args?: unknown) => boolean,
 *   arm: (agent: object, plan: string) => object | undefined,
 *   list: () => string[],
 * }}
 */
export function createGate(ctx, options = {}) {
  const gated = new Set(Array.isArray(options.gatedTools) && options.gatedTools.length > 0
    ? options.gatedTools.filter((name) => typeof name === 'string' && name.trim().length > 0).map((name) => name.trim())
    : DEFAULT_GATED)
  const ttlMinutes = Number.isFinite(options.approvalTtlMinutes) && options.approvalTtlMinutes > 0
    ? options.approvalTtlMinutes
    : 120
  const ttlMs = ttlMinutes * 60_000
  const gateMode = options.gateMode === 'enforce' ? 'enforce' : 'prompt-first'
  const allowReadOnlyShell = options.allowReadOnlyShell !== false
  const states = new WeakMap()
  const statesBySession = new WeakMap()
  const warned = new Set()

  /** Emit one diagnostic at most once per reason. */
  function warnOnce(reason, message) {
    if (warned.has(reason)) return
    warned.add(reason)
    try {
      ctx.logger?.warn?.(message)
    } catch {
      // A logging failure must not affect the gate.
    }
  }

  /** Attach a state to the agent's session so turn boundaries can reset it. */
  function bindSession(state, agent) {
    const session = agent?.session
    if (session === undefined || session === null || typeof session !== 'object') return
    state.session = session
    let bucket = statesBySession.get(session)
    if (bucket === undefined) {
      bucket = new Set()
      statesBySession.set(session, bucket)
    }
    bucket.add(state)
  }

  /** Gate state for one agent, created on first use. */
  function stateFor(agent) {
    if (agent === undefined || agent === null || typeof agent !== 'object') return undefined
    let state = states.get(agent)
    if (state === undefined) {
      state = {
        approved: false,
        approvedAt: 0,
        plan: '',
        generation: 0,
        pending: undefined,
        session: undefined,
      }
      states.set(agent, state)
      bindSession(state, agent)
    }
    return state
  }

  /** Close the gate and invalidate any approval request from an older step. */
  function close(state, { clearPlan = true } = {}) {
    state.approved = false
    state.approvedAt = 0
    state.generation += 1
    state.pending = undefined
    if (clearPlan) state.plan = ''
  }

  // A new user turn is a new approval scope. This is the Host-owned task
  // boundary; the model cannot extend it by forgetting to call prework_plan.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start') return
    const bucket = statesBySession.get(session)
    if (bucket === undefined) return
    for (const state of bucket) close(state)
  })

  /** Whether a tool name is subject to the brake. */
  function isGated(name, args) {
    if (typeof name !== 'string' || name.length === 0) return false
    if (ALWAYS_FREE.has(name)) return false
    if (name === 'postwork_cleanup' && args?.dryRun === true) return false
    if (name === 'ops_bash' && allowReadOnlyShell && isReadOnlyShell(args)) return false
    if (gated.has(name)) return true
    for (const rule of gated) {
      if (rule.endsWith('*') && name.startsWith(rule.slice(0, -1))) return true
    }
    return false
  }

  /** Ask the Host once per pending burst; concurrent calls share one dialog. */
  async function requestApproval(state, exec) {
    if (state.pending !== undefined && state.pending.generation === state.generation) {
      return state.pending.promise
    }
    // The approval service is optional: it is captured through ctx.inject in
    // index.js, because reading an undeclared service off `ctx` is an error in
    // Cordis rather than `undefined`.
    const approval = typeof options.approval === 'function' ? options.approval() : undefined
    if (approval === undefined || approval === null || typeof approval.request !== 'function') {
      warnOnce('approval-unavailable', '开工闸门：审批通道不可用，当前按 gateMode 处理。')
      return 'unavailable'
    }

    // A profile whose approval policy is `never` cannot answer a dialog.
    // prompt-first treats that as the user's choice to run without prompts;
    // enforce keeps the brake and denies the call instead of silently opening.
    try {
      const session = exec.agent === undefined ? undefined : exec.agent.session
      const readPolicy = typeof approval.effectivePolicy === 'function'
        ? approval.effectivePolicy.bind(approval)
        : typeof approval.policyFor === 'function' ? approval.policyFor.bind(approval) : undefined
      if (session !== undefined && readPolicy !== undefined && readPolicy(session) === 'never') {
        warnOnce('policy-never', '开工闸门：审批策略为 never，当前按 gateMode 处理。')
        return 'policy-never'
      }
    } catch {
      // A policy probe that throws must not block the write; fall through to asking.
    }

    const generation = state.generation
    const reason = state.plan.length > 0
      ? '开工闸门：本任务还没有批准开工。清单已登记，请确认后再放行写操作。'
      : '开工闸门：这个任务还没有经过「澄清 → 清单 → 批准」。放行这一批写操作吗？'
    const displayReason = state.plan.length > 0 ? state.plan.slice(0, 600) : undefined
    const promise = Promise.resolve()
      .then(() => approval.request({
        agent: exec.agent,
        toolName: exec.name,
        ...exec.callId === undefined ? {} : { callId: exec.callId },
        reason,
        ...displayReason === undefined ? {} : { displayReason },
        ...exec.signal === undefined ? {} : { signal: exec.signal },
      }))
      .catch(() => 'unavailable')
    const pending = { generation, promise }
    state.pending = pending
    return promise.finally(() => {
      if (state.pending === pending) state.pending = undefined
    }).then((outcome) => (state.generation === generation ? outcome : 'stale'))
  }

  const onPreExecute = async (exec, next) => {
    // Always let the rest of the chain decide first: sandbox policy, other
    // guards, and the built-in approval listener know more than this plugin.
    const decision = await next()
    if (decision === undefined || decision.kind !== 'allow') return decision
    if (exec === undefined || !isGated(exec.name, exec.arguments)) return decision
    const state = stateFor(exec.agent)
    if (state === undefined) {
      return gateMode === 'enforce'
        ? { kind: 'deny', reason: '开工闸门处于 enforce 模式，但这次调用没有可用的 Agent 上下文。' }
        : decision
    }
    if (state.approved && Date.now() - state.approvedAt < ttlMs) return decision

    const outcome = await requestApproval(state, exec)
    if (outcome === 'allowed-once') {
      state.approved = true
      state.approvedAt = Date.now()
      return decision
    }
    if (outcome === 'rejected') {
      return {
        kind: 'deny',
        reason: '开工闸门拦下了这次写操作：用户没有批准。先把方案讲清楚，拿到明确同意再动手。',
      }
    }
    if (outcome === 'policy-never' || outcome === 'unavailable') {
      if (gateMode === 'enforce') {
        return {
          kind: 'deny',
          reason: outcome === 'policy-never'
            ? '开工闸门处于 enforce 模式，但当前审批策略是 never，无法取得批准。'
            : '开工闸门处于 enforce 模式，但审批通道不可用，无法取得批准。',
        }
      }
      state.approved = true
      state.approvedAt = Date.now()
      return decision
    }
    if (outcome === 'cancelled') return { kind: 'cancel' }
    // 'stale': a previous turn or plan invalidated this request. Ask again on
    // the next call instead of applying an approval to the wrong task.
    return outcome === 'stale' ? { kind: 'deny', reason: '开工闸门：旧批准已失效，请重新确认当前任务。' } : decision
  }

  ctx.on('tools/pre-execute', onPreExecute)

  return {
    stateFor,
    isGated,
    /** Register a plan and close the gate for the current turn. */
    arm(agent, plan) {
      const state = stateFor(agent)
      if (state === undefined) return undefined
      state.plan = plan
      close(state, { clearPlan: false })
      return state
    },
    /** Names currently under the brake, for diagnostics and docs. */
    list: () => [...gated],
  }
}

const PLAN_OUTPUT = {
  type: 'object',
  properties: {
    recorded: { type: 'boolean', description: '清单是否已登记' },
    gate: { type: 'string', description: '闸门状态：closed / open / unknown' },
    plan: { type: 'string', description: '登记下来的清单全文' },
    note: { type: 'string', description: '下一步该做什么' },
  },
  required: ['recorded', 'gate', 'plan', 'note'],
  additionalProperties: false,
}

/**
 * Build the `prework_plan` tool: register the checklist and close the gate for
 * the current turn. The written plan is what the approval dialog shows, so the
 * human approves a concrete list rather than a generic "continue?".
 * @param gate - Handle returned by {@link createGate}.
 * @returns Raw tool definition for `ctx.tools.register`.
 */
export function createPlanTool(gate) {
  return {
    name: 'prework_plan',
    description: '登记本次任务的执行清单，并把开工闸门关上（等用户批准）。清单会出现在批准对话框里，所以写清楚每步做什么、影响什么、怎么回滚。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句话任务理解' },
        steps: { type: 'array', items: { type: 'string' }, description: '按顺序的执行步骤' },
        questions: { type: 'array', items: { type: 'string' }, description: '还需要用户拍板的分叉（可为空）' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    output: {
      schema: PLAN_OUTPUT,
      render(args, value) {
        if (!value.recorded) return [{ type: 'text', text: value.note }]
        return [{ type: 'text', text: `已登记清单（闸门：${value.gate}）。\n${value.plan}\n${value.note}` }]
      },
    },
    execute(args, exec) {
      const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
      const steps = Array.isArray(args?.steps) ? args.steps.filter((step) => typeof step === 'string' && step.trim().length > 0) : []
      const questions = Array.isArray(args?.questions) ? args.questions.filter((item) => typeof item === 'string' && item.trim().length > 0) : []
      const lines = [`任务理解：${summary.length > 0 ? summary : '（未填写）'}`]
      if (steps.length > 0) {
        lines.push('执行清单：')
        steps.forEach((step, index) => lines.push(`${index + 1}. ${step.trim()}`))
      }
      if (questions.length > 0) {
        lines.push('待用户决定的岔路：')
        questions.forEach((item, index) => lines.push(`${index + 1}. ${item.trim()}`))
      }
      const plan = lines.join('\n')
      const state = gate.arm(exec === undefined ? undefined : exec.agent, plan)
      if (state === undefined) {
        return {
          recorded: false,
          gate: 'unknown',
          plan,
          note: '没有可用的会话上下文，闸门状态无法登记；按提示词流程直接向用户要批准。',
        }
      }
      return {
        recorded: true,
        gate: 'closed',
        plan,
        note: '闸门已关上：现在把这份清单发给用户，等一句明确的「开工」；批准只在本轮任务内有效。',
      }
    },
  }
}
