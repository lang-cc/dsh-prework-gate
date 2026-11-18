# 开工闸门（dsh-prework-gate）

给 DeepSeek Harness 用的插件：**先问清、再出清单、批准后才动手**，交付之后只清理本轮明确创建的临时文件。

当前版本：`0.3.0`。

它做四件事：

1. **提示词规则**（`index.js`）：往系统提示里加一节高优先级规则——先澄清、核对现状、再出执行清单、最后等批准；只读问答、明确低风险的可逆一步操作、以及用户当轮已给完整规格并说“直接做”的情况不触发。
2. **一轮 grilling**：非平凡任务先问一轮就够——一次问完当前能问的决策（每个问题带推荐答案），答完直接进清单，不挤牙膏。
3. **按轮次生效的硬闸门**（`lib/gate.js`）：未批准的 `write` / `edit` / `apply_patch`、有副作用的 `ops_bash`、非 `dryRun` 的 `postwork_cleanup` 会被 Host 的 `tools/pre-execute` 拦下并走审批。Host 在每次 `turn/start` 自动关闭旧批准，不依赖模型记得调用 `prework_plan`。
4. **保守清理**（`lib/cleanup.js`）：`postwork_cleanup` 只自动删除本会话明确创建、且位于系统临时目录中的文件；工作区文件、修改过的文件、调用方补充的路径、交付物、备份和用户数据只报告，不自动删除。

## 安装

纯 Host 插件，无依赖、无构建步骤。

1. DSH 里打开 **插件** → **添加插件**，选本目录；或用 `plugin_manager` 工具
   （`action: install_bundle`，`target` 填本目录绝对路径）。
2. 列表里显示为 **开工闸门 / Prework gate**。在 `cordis.patch.yml` 里把
   `enabled` 改成 `false` 可关掉。

安装后需要重启 DSH 才会加载新增的工具；提示词部分也在重启后生效。

## 配置

```yaml
- insert:
    - id: prework-gate
      name: 'dsh-prework-gate'
      config:
        enabled: true             # false = 不注册任何东西
        order: 400                # 提示位置，越小越靠前、权重越高
        strictness: adaptive      # adaptive | always | strict
        extraRules: []            # 追加到规则末尾的补充条款
        grill: true               # 一轮提问（false = 只保留四步闸门）
        gate: true                # 硬拦截写操作
        gateMode: prompt-first    # prompt-first | enforce
        allowReadOnlyShell: true  # 明确只读的 ops_bash 直接放行
        gatedTools: []            # 覆盖默认拦截名单，支持 'write*' 通配
        approvalTtlMinutes: 120   # 批准的兜底有效期；换轮次立即失效
        cleanup: true             # 注册 postwork_cleanup 工具
        maxCleanupPerRun: 50      # 单次最多移入回收站多少个
```

`order: 400` 位于内置的计划策略（500）和所有工具说明（1000+）之前，因此比
默认行为更“强势”。想弱化就调大这个值。

`strictness`：

| 取值 | 行为 |
| --- | --- |
| `adaptive`（默认） | 明确、低风险、可逆的一步操作：复述理解并问一句；其余走完整四步清单。 |
| `always` | 每个任务都走完整四步，不用任务大小做例外。 |
| `strict` | 完整四步 + 至少 2 个澄清问题 + 清单必须含风险与回滚列 + “你看着办”要先列 A/B 让你挑。 |

`gateMode`：

| 取值 | 审批通道不可用或策略为 `never` 时 |
| --- | --- |
| `prompt-first`（默认） | 放行，并在 Host 日志里提示一次降级原因。 |
| `enforce` | 拒绝写操作，避免在没有审批通道时静默执行。 |

## 工具

| 工具 | 作用 |
| --- | --- |
| `prework_plan` | 登记本轮任务的清单并关上闸门；清单会出现在批准对话框里。 |
| `postwork_cleanup` | 扫描本会话记录；`paths` 只能追加候选，`dryRun: true` 只报告不删除。 |

`postwork_cleanup` 的分级规则：

- **自动移入回收站**：本会话明确创建、且位于 `%TEMP%` / `os.tmpdir()` 等临时目录中的文件，且小于 200MB。
- **只报告、不删除**：工作区文件、修改过的文件、`.bak` / `.old` / `.orig` 备份、目录、超过 200MB 的文件，以及调用方通过 `paths` 临时传入的候选。
- **永不自动删除**：`present` 登记过的交付物、`.git`、符号链接/junction、`~/.dsh` 配置与记忆库、常见用户数据目录和系统目录。

删除优先使用 Windows 回收站（`Microsoft.VisualBasic.FileIO`）；失败时退回 `%TEMP%\prework-gate-trash\<时间戳>-<随机后缀>\`。回退移动使用 Node `fs` API，不经过 `cmd` 或外部 `mv`，失败会保留原文件并报告。

## 命令闸门

`ops_bash` 默认纳入拦截，但只对明确只读的命令免审批：

- 允许：`pwd`、`ls`、`git status`、`git diff`、`git log`、`git show`、`Get-ChildItem`、`Get-Content`、`Get-Command`、`Test-Path`、版本查询等。
- 需要审批：脚本路径、管道/重定向/命令串联、删除、移动、安装、构建、Git 写操作、带 `--output` 的 diff，以及任何无法确定只读性的命令。
- 这不是 shell 安全沙箱；只为常见只读查询减少无意义弹框，未知命令一律保守处理。

## 验证

```bash
node test/run.mjs
```

19 项检查覆盖：提示词规则、工具 schema、按轮次自动上闸、旧批准失效、拒绝/取消、`never` 策略、无审批通道的两种模式、只读命令分类、清理来源/交付物/备份保护、失败写入不登记、移动只记录目标路径、相对路径解析和清理审批。

## 已知限制

- `prompt-first` 在审批策略为 `never` 或审批通道不可用时仍会放行；需要强制安全时使用 `gateMode: enforce`。
- 命令分类只覆盖明确 allow-list；复杂脚本、动态命令和多层 shell 会进入审批，不会做深度语义分析。
- `gatedTools` 可以覆盖默认拦截名单；把 `ops_bash` 从名单移除会失去命令层保护。
- 清理只认本会话明确创建并登记的路径和显式 `paths`，不扫描历史垃圾；`paths` 不会直接触发自动删除。
- 每个请求的系统提示会增加约 1–2 千字。

## 许可

MIT。
