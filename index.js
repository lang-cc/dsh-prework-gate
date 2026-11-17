/**
 * dsh-prework-gate — Host half of the bundle.
 *
 * Registers one system-prompt section that makes the agent ask first, propose a
 * plan second, and act only after the user approves. No tools, no UI, no state:
 * the section is re-assembled with every request, so it applies to every session
 * of the profile, including resumed ones.
 */

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
 * Register the gate section.
 * @param ctx - Host plugin context (needs `systemPrompt`).
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

  const parts = [BASE_RULES, mode]
  if (extraRules.length > 0) {
    parts.push(['补充规则：', ...extraRules.map((rule) => `- ${rule.trim()}`)].join('\n'))
  }

  ctx.systemPrompt.section({
    name: 'prework-gate',
    order,
    text: parts.join('\n\n'),
  })
}

/** Only the prompt registry is required; stay inactive when it is absent. */
export const inject = ['systemPrompt']
