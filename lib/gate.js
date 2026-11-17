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
 * - Approval is per agent (one Cordis session), not global: every session keeps
 *   its own brake.
 * - The first approval unlocks the rest of the task until `prework_plan` runs
 *   again (the model uses that to close the gate for the next task), or until
 *   the approval TTL lapses.
 * - The gate never invents its own dialog channel: it goes through
 *   `ctx.approval.request()`, which is a one-shot Host approval with audit. When
 *   that seam is missing the gate fails open on purpose — an unusable dialog
 *   must not brick every write in the profile.
 */

/** Tools that always run without asking, whatever the gate says. */
const ALWAYS_FREE = new Set(['prework_plan', 'postwork_cleanup', 'todo_write'])

/** Default brake list: tools that change the workspace or the profile. */
const DEFAULT_GATED = [
  'write',
  'edit',
  'apply_patch',
  'plugin_manager',
  'str_replace',
  'str_replace_editor',
  'multiedit',
  'notebook_edit',
  'create_file',
  'move_file',
  'delete_file',
]

/**
 * Per-agent gate state.
 * @param ctx - Host plugin context.
 * @param options - { gatedTools, approvalTtlMinutes }.
 * @returns {{ stateFor, isGated, list }}
 */
export function createGate(ctx, options = {}) {
  const gated = new Set(Array.isArray(options.gatedTools) && options.gatedTools.length > 0
    ? options.gatedTools.filter((name) => typeof name === 'string' && name.trim().length > 0).map((name) => name.trim())
    : DEFAULT_GATED)
  const ttlMinutes = Number.isFinite(options.approvalTtlMinutes) && options.approvalTtlMinutes > 0
    ? options.approvalTtlMinutes
    : 120
  const ttlMs = ttlMinutes * 60_000
  const states = new WeakMap()

  /** Gate state for one agent, created on first use. */
  function stateFor(agent) {
    if (agent === undefined || agent === null || typeof agent !== 'object') return undefined
    let state = states.get(agent)
    if (state === undefined) {
      state = { approved: false, approvedAt: 0, plan: '', pending: undefined }
      states.set(agent, state)
    }
    return state
  }

  /** Whether a tool name is subject to the brake. */
  function isGated(name) {
    if (typeof name !== 'string' || name.length === 0) return false
    if (ALWAYS_FREE.has(name)) return false
    if (gated.has(name)) return true
    for (const rule of gated) {
      if (rule.endsWith('*') && name.startsWith(rule.slice(0, -1))) return true
    }
    return false
  }

  /** Ask the Host once per pending burst; concurrent calls share one dialog. */
  async function requestApproval(state, exec) {
    if (state.pending !== undefined) return state.pending
    const approval = ctx.get('approval')
    if (approval === undefined || typeof approval.request !== 'function') return 'unavailable'
    const reason = state.plan.length > 0
      ? '开工闸门：本任务还没有批准开工。清单已登记，请确认后再放行写操作。'
      : '开工闸门：这个任务还没有经过「澄清 → 清单 → 批准」。放行这一批写操作吗？'
    const displayReason = state.plan.length > 0 ? state.plan.slice(0, 600) : undefined
    const pending = Promise.resolve()
      .then(() => approval.request({
        agent: exec.agent,
        toolName: exec.name,
        ...exec.callId === undefined ? {} : { callId: exec.callId },
        reason,
        ...displayReason === undefined ? {} : { displayReason },
        ...exec.signal === undefined ? {} : { signal: exec.signal },
      }))
      .catch(() => 'unavailable')
      .finally(() => {
        state.pending = undefined
      })
    state.pending = pending
    return pending
  }

  const onPreExecute = async (exec, next) => {
    // Always let the rest of the chain decide first: sandbox policy, other
    // guards, and the built-in approval listener know more than this plugin.
    const decision = await next()
    if (decision === undefined || decision.kind !== 'allow') return decision
    if (exec === undefined || !isGated(exec.name)) return decision
    const state = stateFor(exec.agent)
    if (state === undefined) return decision
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
    if (outcome === 'cancelled') return { kind: 'cancel' }
    // 'unavailable' (no answerer, closed turn, approval seam absent): fail open.
    return decision
  }

  ctx.on('tools/pre-execute', onPreExecute)

  return {
    stateFor,
    isGated,
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
 * the next task. The written plan is what the approval dialog shows, so the
 * human approves a concrete list rather than a generic "continue?".
 * @param gate - Handle returned by {@link createGate}.
 * @returns Raw tool definition for `ctx.tools.register`.
 */
export function createPlanTool(gate) {
  return {
    name: 'prework_plan',
    description: '登记本次任务的执行清单，并把开工闸门重新关上（等用户批准）。清单会出现在批准对话框里，所以写清楚每步做什么、影响什么、怎么回滚。',
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
      const state = gate.stateFor(exec === undefined ? undefined : exec.agent)
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
      if (state === undefined) {
        return {
          recorded: false,
          gate: 'unknown',
          plan,
          note: '没有可用的会话上下文，闸门状态无法登记；按提示词流程直接向用户要批准。',
        }
      }
      state.plan = plan
      state.approved = false
      state.approvedAt = 0
      return {
        recorded: true,
        gate: 'closed',
        plan,
        note: '闸门已关上：现在把这份清单发给用户，等一句明确的「开工」；批准后本次任务的写操作会自动放行。',
      }
    },
  }
}
