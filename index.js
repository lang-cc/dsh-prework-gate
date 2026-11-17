/**
 * dsh-prework-gate — Host half of the bundle.
 *
 * v0.2 keeps the prompt section and adds the two halves the prompt alone could
 * not deliver:
 * - a hard brake on write-ish tools (`lib/gate.js`), so an unplanned write is
 *   stopped by the Host instead of a polite paragraph;
 * - a session-scoped cleanup tool (`lib/cleanup.js`), so the agent can tidy the
 *   temp files it produced without ever touching deliverables.
 *
 * No client half, no build step: everything registers through the Host context
 * inside `apply()`, which the profile calls once per load.
 */

import { createGate, createPlanTool } from './lib/gate.js'
import { createCleanupTool, createRegistry, trackToolCalls } from './lib/cleanup.js'

/** Highest-priority working rules. Positioned early (order 400) on purpose. */
const BASE_RULES = `## 开工闸门 — 先问清、再出清单、批准后才动手（最高优先级工作规则）

这条规则优先于一切「直接开始」的默认倾向，也优先于你对效率的自行判断。用户交来任何任务（写代码、改配置、装或卸软件、改文件、跑命令、做文档、排查故障、部署、发布）时：

1. 先澄清。用 ask_user_question 一次问清（最多 4 问）：目标（怎样算完成）、范围（要改什么、明确不要动什么）、约束（版本、环境、时间、不能用什么）、验收（怎么证明好了）。能只读自查的（读文件、看版本、查配置、查资料）自己查，不要拿问题消耗用户时间。信息已经足够时跳过提问，并说明「信息已足够，跳过澄清」。
2. 再调研。找现成方案与相似实现（搜索、官方文档、GitHub），确认可复用的技能或工具，只读摸清现状。给出 2–3 个候选与取舍理由。
3. 再出清单。固定格式：任务理解（一句话）、调研结果、执行清单表（每步：步骤、影响面、风险、回滚方式）、需要用户决定的分叉、请确认。每步都要可验证；风险中高的步骤必须先写备份方式；删除数据、改注册表、装服务、卸载、远程操作、对外发布要单独标出。
4. 最后等批准。只有用户明确回复「可以 / 开工 / 按这个做」之后才开始执行。批准只覆盖清单内的步骤，清单外的事必须重新确认；执行中要偏离清单，先停下来重新确认。

禁止：把「你看着办」当成授权；先做一半再问；在清单里藏未说明的危险步骤；报告「已完成」却不给验证方式；未经批准就写文件、装包、改配置、删东西、推送代码。

例外（可以直接做，但要先说一句「按例外直接做了」）：纯只读问答与解释；单行零风险笔误修正；用户当轮已给出完整规格并明说「直接做」。

收尾：完成后报告「做了什么 / 怎么验证的 / 还差什么」。`

/** One-round grilling: ask everything you can ask now, then move on. */
const GRILL_RULES = `## 提问方式 — 一轮问完，不要挤牙膏

非平凡任务先问一轮，禁止边做边问：

- 一次最多 4 个问题，全部编号，每个问题都附上你推荐的答案和一句理由；用户只需要回答「同意／改成 X」。
- 只问查不到、只能由用户拍板的决策（目标、取舍、边界、能不能接受某个副作用）。事实类问题（版本、路径、配置值、库的用法）自己去读文件、跑只读命令、查文档，不许占问题名额。
- 用户答完这一轮就直接进执行清单；只有新的回答打开了新的关键分叉时，才允许问第二轮。
- 小任务（单文件、可回滚、几分钟做完）不 grill，一句话复述理解即可。
- 不要问「你要不要我继续」这类空问题：要么问决策，要么直接干。`

/** The hard brake is visible to the agent, so a denial reads as a process step. */
const GATE_RULES = `## 硬闸门 — 未批准的写操作会被 Host 拦下

- 每个新任务开始时先调用 prework_plan 登记清单：它会把闸门重新关上，并把你写的清单挂在批准对话框上。
- 用户批准后，本任务的后续写操作自动放行；换任务时再调一次 prework_plan 就会重新上闸。
- 没有批准时，write / edit / apply_patch 会被拦下并弹确认框（plugin_manager 不拦：它是出问题时的恢复通道）。被拦不是故障：回到「讲清楚 → 拿批准」，不要绕道用 ops_bash 或其它工具偷偷改文件。
- 只读操作、todo_write、prework_plan、postwork_cleanup 不受闸门影响。`

/** Cleanup contract: what may go, what must stay, what to report. */
const CLEANUP_RULES = `## 收尾 — 交付后清掉本轮垃圾

- 任务交付、验收通过后，调用 postwork_cleanup 清掉本轮产生的临时文件、日志、构建残留、临时脚本。它只动临时产物，交付物、备份、.git、用户数据会被自动列为保留。
- 先报告「删了什么、留了什么、为什么留」，不要静默删除；验收没通过的备份先留着，等用户确认再清。
- 交付物永不删除，哪怕它看起来像中间产物；不要移动用户文件的位置，只清理垃圾。
- 清理与交付分开说：交付物清单在前，清理结果在后。`

/** Per-mode strength of the gate. */
const MODES = {
  adaptive: `当前力度：自适应。
- 小改动（单文件、可回滚、几分钟内能做完）：一句话复述你的理解，加一句「我按 X 做，可以吗」，得到同意就做。
- 跨文件改动、装或卸包、改配置、删数据、远程操作、对外发布：走完整四步清单，不省略。`,
  always: `当前力度：每次都走完整四步。
不论任务大小，一律先澄清、再调研、再出清单，拿到用户明确批准后才动手；不要自行判断某个任务「小到可以跳过」。`,
  strict: `当前力度：严格。
每次任务都走完整四步，并且：
- 澄清阶段至少问 2 个问题（除非用户已给出目标、范围、验收三项）；
- 清单必须包含风险与回滚两列，缺任何一列都不算完成；
- 用户只说「你看着办」时，先把最可能的两种做法列成 A/B 分叉让用户挑，不得自行选定。`,
}

/**
 * Register the gate section, the brake, and the cleanup tool.
 * @param ctx - Host plugin context (needs `systemPrompt`, optionally `tools` / `approval`).
 * @param config - Row config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const options = config ?? {}
  if (options.enabled === false) return

  const order = Number.isFinite(options.order) ? options.order : 400
  const mode = MODES[options.strictness] ?? MODES.adaptive
  const extraRules = Array.isArray(options.extraRules)
    ? options.extraRules.filter((rule) => typeof rule === 'string' && rule.trim().length > 0)
    : []
  const grill = options.grill !== false
  const gateEnabled = options.gate !== false
  const cleanupEnabled = options.cleanup !== false

  // `approval` stays optional: capture it in its own inject scope so the gate
  // can ask when the service exists and fail open when it does not. Reading an
  // undeclared service straight off `ctx` throws in Cordis, so never do that.
  let approvalScope
  ctx.inject(['approval'], (scope) => {
    approvalScope = scope
    return () => {
      approvalScope = undefined
    }
  })

  const toolsAvailable = typeof ctx.tools?.register === 'function'
  const gate = gateEnabled ? createGate(ctx, {
    gatedTools: options.gatedTools,
    approvalTtlMinutes: options.approvalTtlMinutes,
    approval: () => (approvalScope === undefined ? undefined : approvalScope.approval),
  }) : undefined
  const registry = cleanupEnabled ? createRegistry() : undefined

  if (toolsAvailable && gate !== undefined) {
    ctx.tools.register(createPlanTool(gate))
  }
  if (toolsAvailable && registry !== undefined) {
    trackToolCalls(ctx, registry)
    ctx.tools.register(createCleanupTool(registry, { maxDelete: options.maxCleanupPerRun }))
  }

  const parts = [BASE_RULES, mode]
  if (grill) parts.push(GRILL_RULES)
  if (gateEnabled) parts.push(GATE_RULES)
  if (cleanupEnabled) parts.push(CLEANUP_RULES)
  if (extraRules.length > 0) {
    parts.push(['补充规则：', ...extraRules.map((rule) => `- ${rule.trim()}`)].join('\n'))
  }

  ctx.systemPrompt.section({
    name: 'prework-gate',
    order,
    text: parts.join('\n\n'),
  })
}

/** The prompt registry and the tool registry are required; approval is optional. */
export const inject = ['systemPrompt', 'tools']
