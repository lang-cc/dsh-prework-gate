# 开工闸门 / Prework gate

## 它做什么

插件由三块组成：提示词规则、硬闸门、收尾清理。

### 1. 提示词规则（`index.js`）

往系统提示里注册一节规则（`prework-gate`，默认 order 400），使本 profile 的所有会话在改动任何东西之前按固定顺序工作：

1. **澄清** —— 用 `ask_user_question` 一次问清目标、范围（含“不要动什么”）、约束、验收；能只读自查的自己查。信息已足够时跳过提问并说明。
2. **调研** —— 找现成方案/相似实现，确认可复用技能，只读摸清现状，给 2–3 个候选与取舍理由。
3. **清单** —— 任务理解一句话 + 调研结果 + 执行清单表（步骤 / 影响面 / 风险 / 回滚方式）+ 待定分叉 + 请确认。每步可验证；中高风险步骤必须写明备份方式；删数据、改注册表、装服务、卸载、远程操作、对外发布单独标出。
4. **等批准** —— 只有明确回复「可以 / 开工 / 按这个做」才开始；批准只覆盖清单内步骤，清单外的重新确认；执行中要偏离清单先停下重问。

**一轮提问**：非平凡任务只问一轮，一次问完当前能问的决策（≤4 问，每问带推荐答案），答完直接进清单，不边做边问。事实类问题自己去查，不占问题名额。

不触发的情况：纯只读问答与解释；单行零风险笔误修正；用户当轮已给出完整规格并明说「直接做」。例外发生时先说一句“按例外直接做了”。

### 2. 硬闸门（`lib/gate.js`）

`tools/pre-execute` 是工具管线的有序 allow/deny/ask 闸口。插件在它上面挂一个监听器：

- 先 `await next()`，让沙箱策略和其它插件先决定；它们已经拒绝就原样返回。
- 只处理名单内的工具（默认 `write`、`edit`、`apply_patch`、`plugin_manager`、`str_replace*`、`multiedit`、`notebook_edit`、`create_file`、`move_file`、`delete_file`），`todo_write`、`prework_plan`、`postwork_cleanup` 永久放行，`ops_bash` 默认不拦（否则每条命令都弹框）。
- 该 agent 还没有批准过 → 调 `ctx.approval.request({ agent, toolName, callId, reason, displayReason, signal })`，把 `prework_plan` 登记的清单作为 `displayReason` 显示在批准框里。
- 返回 `allowed-once` → 标记本任务已放行（默认 120 分钟后自动失效）；`rejected` → 返回 `{ kind: 'deny', reason }`，模型收到一条“回到讲清楚拿批准”的错误；`cancelled` → 返回 `{ kind: 'cancel' }`。
- 审批通道不可用（没有 answerer、turn 已关闭、服务不存在）→ **放行**。宁可漏拦，也不要把整个 profile 的写操作卡死。

并发调用共享同一个挂起的批准请求，不会连弹多个框。

### 3. 收尾清理（`lib/cleanup.js`）

`tools/post-execute` 记录本会话写过的路径（`write` / `edit` / `apply_patch` 等工具参数里的 path 类字段），`present` 的参数记为交付物。

`postwork_cleanup` 工具按三级处理候选路径：

| 级别 | 判据 | 行为 |
| --- | --- | --- |
| 自动删 | 位于系统临时目录；或 `.tmp` / `.log` / `.swp` / `~` 之类临时文件名；且 < 200MB | 移入回收站 |
| 先问 | `.bak` / `.old` 备份、≥ 200MB、目录、写工具在工作区产生但可能是交付物的文件 | 列出来，不动 |
| 永不删 | `present` 登记过的交付物、`.git`、符号链接 / junction、`~/.dsh`、系统目录、用户数据 | 直接跳过 |

删除优先用 Windows 回收站（`Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile` + `SendToRecycleBin`，PowerShell `-EncodedCommand` 传参，避免中文路径乱码）；失败时退回到 `%TEMP%\prework-gate-trash\<时间戳>\`。单次上限默认 50 个，超出的列进“下次再清”。

清理后会反查交付物是否仍然存在，缺了会在 `note` 里点名。

## 用法

安装后无需操作：规则随每次请求重新组装，新会话、续接会话都生效；工具需要重启 DSH 后出现。

三种力度（`strictness`）：

- `adaptive`（默认）：小改动一句话复述 + 问一句；其余走完整四步。
- `always`：所有任务都走完整四步。
- `strict`：完整四步 + 至少 2 个澄清问题 + 风险/回滚列强制 + “你看着办”必须先给 A/B。

`order` 控制提示中的位置，默认 400：位于内置计划策略（500）与工具说明（1000+）之前，因此在模型中权重偏高。调大即弱化。

`extraRules` 可追加你自己的条款，例如：

```yaml
extraRules:
  - '删除任何文件前，先列出绝对路径清单让我核对。'
  - '不要用桌面自动化代我点击界面。'
```

## 限制

- 硬闸门依赖审批服务的 `ask` 策略：`never` 策略下直接放行（对话框永远拿不到批准，拦下来只会把写操作全变成拒绝）；没有审批通道或不在 turn 内同样放行。
- 只拦名单内工具；`ops_bash` 需要自己加。
- 清理只认本会话登记的路径与显式 `paths`，不扫工作区历史垃圾。
- 每个请求的系统提示会多出 1–2 千字。
- 只影响加载它的 profile；切换 profile 或禁用行即失效。
