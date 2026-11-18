# 开工闸门 / Prework gate

版本 `0.3.0` 的重点是把“任务生命周期”和“清理来源”从模型自觉，改为 Host 可验证的状态。

## 它做什么

插件由三块组成：提示词规则、按轮次生效的硬闸门、保守的收尾清理。

### 1. 提示词规则（`index.js`）

往系统提示里注册一节规则（`prework-gate`，默认 order 400），使本 profile 的所有会话在改动前按固定顺序工作：

1. **澄清** —— 用 `ask_user_question` 一次问清目标、范围、约束、验收；能只读自查的自己查。
2. **核对现状** —— 只读检查相关文件和配置。只有真实技术分叉、用户要求比较或复用价值明显时才做快速调研，不强制每个任务搜索。
3. **清单** —— 任务理解、当前情况、执行步骤、影响面、风险、回滚方式、待定分叉和确认请求。
4. **等批准** —— 只有明确回复「可以 / 开工 / 按这个做」才开始；批准只覆盖当前任务。

不触发的情况：纯只读问答与解释；明确、低风险、可逆的一步操作；用户当轮已给完整规格并明说「直接做」。例外发生时先说一句“按例外直接做了”。

### 2. 硬闸门（`lib/gate.js`）

`tools/pre-execute` 是工具管线的有序 allow/deny/ask 闸口。插件在该事件上挂监听器：

- 先 `await next()`，让沙箱策略和其它插件先决定；它们已经拒绝就原样返回。
- 默认处理 `write`、`edit`、`apply_patch`、`str_replace*`、`multiedit`、`notebook_edit`、`create_file`、`move_file`、`delete_file`、`ops_bash` / `bash` / `pwsh` / `shell`、非 dry-run 的 `postwork_cleanup`。
- `todo_write`、`prework_plan`、`present` 永久放行；`postwork_cleanup` 的 `dryRun: true` 放行；`plugin_manager` 故意不拦，作为插件故障时的恢复通道。
- **批准按轮次隔离。** 插件监听 `session/event` 的 `turn/start`：新用户轮次开始时会关闭该会话下所有闸门，清空旧计划和旧批准，并使仍在等待的旧审批请求失效。模型忘记调用 `prework_plan` 也不会继承旧批准。
- `prework_plan` 登记清单并关闭当前轮次的闸门；批准仍由 Host 审批对话框在第一次写操作时完成，而不是由模型自说自话。
- 同一个任务内，一次 `allowed-once` 会放行后续写操作，直到轮次切换、重新登记计划或 TTL 到期。默认 TTL 120 分钟只是兜底。
- 并发写操作共享同一个待处理批准请求；计划变化或轮次切换后，旧请求返回 `stale`，不会错误放行新任务。

#### 审批模式

- `prompt-first`（默认）：审批服务不存在、当前不在 turn 内，或审批策略为 `never` 时放行，并在 Host 日志中提示一次降级原因。
- `enforce`：同样情况下拒绝写操作。审批策略为 `never` 时，需要先切换到可审批的权限模式，否则写操作会被明确拦截。

#### shell 命令

`ops_bash` 默认纳入闸门，但有一条很小的只读 allow-list：`pwd`、`ls`、`git status`、`git diff`、`git log`、`git show`、`Get-ChildItem`、`Get-Content`、`Get-Command`、`Test-Path`、版本查询等。脚本路径、管道、重定向、命令串联、删除/移动/安装/构建、Git 写操作和未知命令都会进入审批。它不是 shell 安全沙箱，只是减少常见只读检查的弹框。

### 3. 收尾清理（`lib/cleanup.js`）

`tools/pre-execute` 记录写工具调用前的目标状态（是否存在），`tools/post-execute` 只在工具成功时登记：

- `write` / `edit` / `apply_patch` / `str_replace*` / `multiedit` / `notebook_edit` / `create_file`：登记目标文件，并区分 `created` 和 `modified`。
- `move_file` / `move` / `rename`：只登记目标路径，绝不登记源路径。
- `delete_file` / `delete` / `remove`：不登记为清理候选。
- `present`：登记交付物，清理永不触碰。

`postwork_cleanup` 工具按三级处理候选路径：

| 级别 | 判据 | 行为 |
| --- | --- | --- |
| 自动移入回收站 | 本会话明确创建，且位于 `os.tmpdir()` / `%TEMP%` / `%TMP%` 等临时根下，< 200MB | 优先 Windows 回收站，失败后移到带随机后缀的临时 trash 目录 |
| 只报告 | 工作区文件、修改过的文件、`.bak` / `.old` / `.orig` 备份、目录、≥200MB、调用方 `paths` 补充的候选 | 列入 `kept`，不删除 |
| 永不自动删 | `present` 交付物、`.git`、符号链接/junction、`~/.dsh`、常见用户数据目录、系统目录 | 直接保护 |

调用方传入的 `paths` 永远不会自动删除，只用于报告候选；这避免了模型用 `paths` 绕过来源登记。

删除路径实现：

- Windows 回收站通过 PowerShell `-EncodedCommand` 调 `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile(..., NoUI, SendToRecycleBin)`，避免中文路径经过 shell 拼接。
- 回退移动使用 Node `fs.mkdirSync`、`fs.renameSync`；跨盘 `EXDEV` 时用 `copyFileSync` + `unlinkSync`，不使用 `cmd /c move` 或外部 `mv`。
- 子进程会检查 `error`、退出码和每个路径的结果，不会把无输出当成成功。

## 配置示例

```yaml
- insert:
    - id: prework-gate
      name: 'dsh-prework-gate'
      config:
        enabled: true
        order: 400
        strictness: adaptive
        gateMode: prompt-first
        allowReadOnlyShell: true
        gate: true
        cleanup: true
        maxCleanupPerRun: 50
        extraRules:
          - '删除任何文件前，先列出绝对路径清单让我核对。'
```

## 验证

```bash
node test/run.mjs
```

当前 18 项测试覆盖：提示词、JSON schema、按轮次自动上闸、旧批准失效、拒绝/取消、`never` 策略、无审批通道的两种模式、只读命令分类、清理分级、失败写入排除、移动源路径排除、交付物保护，以及清理工具自身的审批。

## 限制

- `prompt-first` 在无法取得批准时仍会放行；需要 fail-closed 时使用 `enforce`。
- 命令分类是 allow-list，不解析复杂 shell 语义；未知命令进入审批。
- 清理不会扫描会话历史垃圾，也不会清理工作区中的创建文件；这些只报告。
- 只影响加载它的 profile；切换 profile 或禁用行即失效。
