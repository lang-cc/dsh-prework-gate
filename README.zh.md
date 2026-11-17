# 开工闸门（dsh-prework-gate）

给 DeepSeek Harness 用的插件：**先问清、再出清单、批准后才动手**，交付之后顺手把本轮垃圾清掉。

它做四件事：

1. **提示词规则**（`index.js`）：往系统提示里加一节高优先级规则——先澄清（目标、范围、约束、验收，最多 4 问）、再调研、再出执行清单、最后等批准；只读问答、单行笔误、以及你当轮已给完整规格并说“直接做”的情况不触发。
2. **一轮 grilling**：非平凡任务先问一轮就够——一次问完当前能问的决策（每个问题带推荐答案），答完直接进清单，不挤牙膏。
3. **硬闸门**（`lib/gate.js`）：`write` / `edit` / `apply_patch` / `plugin_manager` 等写操作如果还没批准，会被 Host 的 `tools/pre-execute` 拦下并弹确认框；批准一次放行本任务，新任务重新上闸。
4. **收尾清理**（`lib/cleanup.js`）：`postwork_cleanup` 工具把本会话产生的临时文件、日志、构建残留移入回收站；交付物、`.git`、备份、用户数据永远不动。

## 安装

纯 Host 插件，无依赖、无构建步骤。

1. DSH 里打开 **插件** → **添加插件**，选本目录；或用 `plugin_manager` 工具
   （`action: install_bundle`，`target` 填本目录绝对路径）。
2. 列表里显示为 **开工闸门 / Prework gate**。在 `cordis.patch.yml` 里把
   `enabled` 改成 `false` 可关掉。

安装后需要重启 DSH 才会加载新增的工具（提示词部分改文案则重启即生效）。

## 配置

```yaml
- insert:
    - id: prework-gate
      name: 'dsh-prework-gate'
      config:
        enabled: true          # false = 不注册任何东西
        order: 400             # 提示位置，越小越靠前、权重越高
        strictness: adaptive   # adaptive | always | strict
        extraRules: []         # 追加到规则末尾的补充条款
        grill: true            # 一轮提问（false = 只保留四步闸门）
        gate: true             # 硬拦截写操作
        gatedTools: []         # 覆盖默认拦截名单，支持 'write*' 通配
        approvalTtlMinutes: 120 # 一次批准的存活时间，过期重新上闸
        cleanup: true          # 注册 postwork_cleanup 工具
        maxCleanupPerRun: 50   # 单次最多删多少个
```

`order: 400` 位于内置的计划策略（500）和所有工具说明（1000+）之前，因此比
默认行为更“强势”。想弱化就调大这个值。

`strictness`：

| 取值 | 行为 |
| --- | --- |
| `adaptive`（默认） | 小改动（单文件、可回滚）：复述理解 + 问一句即可；其余走完整四步清单。 |
| `always` | 每个任务都走完整四步，不用任务大小做例外。 |
| `strict` | 完整四步 + 至少 2 个澄清问题 + 清单必须含风险与回滚列 + “你看着办”要先列 A/B 让你挑。 |

## 工具

| 工具 | 作用 |
| --- | --- |
| `prework_plan` | 登记本次任务的清单，并把闸门重新关上；清单全文会显示在批准框里。 |
| `postwork_cleanup` | 清理本会话的临时产物：`paths` 追加候选，`dryRun: true` 只扫描不删。 |

`postwork_cleanup` 的分级规则：

- **自动删**：临时目录（`%TEMP%` 等）里的产物、`.tmp` / `.log` / `.swp` 之类的临时文件名，且小于 200MB。
- **先问、不自动删**：`.bak` / `.old` 备份、超过 200MB 的文件、目录、工作区里由写工具产生但不确定是不是交付物的文件。
- **永不删**：`present` 登记过的交付物、`.git`、符号链接/junction、`~/.dsh` 配置与记忆库、系统目录、用户数据。

删除走 Windows 回收站（`Microsoft.VisualBasic.FileIO`），失败时退回到 `%TEMP%\prework-gate-trash\<时间戳>\`；每次清理都会回报删了什么、留了什么、为什么留。

## 验证

```bash
node test/run.mjs
```

12 项检查覆盖：提示词四个板块、工具 schema 是否落在 DSH 支持的 JSON Schema 子集内、闸门的“问一次→放行整任务→新任务重新上闸”、拒绝后变 deny、临时文件实删、备份与交付物不被删。

跑完再新开一个会话，让我改个文件：正常应该先弹批准框，而不是直接写。

## 已知限制

- 硬闸门只在 `ctx.get('approval')` 可用时生效。没有审批通道（或当前没有打开的 turn）时闸门会**放行**，避免把整个 profile 的写操作卡死。
- 只拦名单里的工具：`ops_bash` 默认不拦（否则每条命令都弹框），需要时用 `gatedTools` 自己加。
- 清理只认本会话登记过的路径与自己传进来的 `paths`，不扫工作区历史垃圾。
- 每个请求的系统提示会多出 1–2 千字。

## 许可

MIT。
