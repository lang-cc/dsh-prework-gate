# dsh-prework-gate

A DeepSeek Harness (DSH) profile plugin: **ask first, plan second, act third — then clean up only what this session created.**

Current version: `0.3.0`.

Four parts:

1. **Prompt rules** (`index.js`): a high-priority system-prompt section that makes the agent clarify, inspect, publish an execution list, and wait for explicit approval. Plain read-only questions, clear low-risk reversible one-step changes, and turns with a complete spec plus “just do it” stay exempt.
2. **One-round grilling**: for non-trivial work the agent asks everything it can ask now — at most four numbered questions, each with a recommended answer — then goes straight to the list.
3. **Turn-scoped hard brake** (`lib/gate.js`): unapproved `write` / `edit` / `apply_patch`, side-effecting `ops_bash`, and non-dry-run `postwork_cleanup` calls are stopped by `tools/pre-execute`. The Host closes every old approval on `turn/start`; this does not depend on the model remembering to call `prework_plan`.
4. **Conservative cleanup** (`lib/cleanup.js`): `postwork_cleanup` auto-removes only files explicitly created in this session and located under the OS temp root. Workspace files, modified files, caller-supplied paths, deliverables, backups, and user data are reported but never auto-deleted.

## Install

Host-only bundle, no dependencies, no build step.

1. In DSH open **Plugins**, choose **Add plugin**, and pick this directory; or
   install it with the `plugin_manager` tool (`action: install_bundle`, target = absolute path to this directory).
2. The row appears as **开工闸门 / Prework gate**. Turn it off with
   `enabled: false` in `cordis.patch.yml`, or from **Plugins**.

The new tools load after a DSH restart; prompt changes apply on restart too.

## Configuration

```yaml
- insert:
    - id: prework-gate
      name: 'dsh-prework-gate'
      config:
        enabled: true             # false = register nothing at all
        order: 400                # prompt position; smaller = earlier and stronger
        strictness: adaptive      # adaptive | always | strict
        extraRules: []            # extra constraint lines appended to the section
        grill: true               # the one-round questioning pass
        gate: true                # the hard brake on write tools
        gateMode: prompt-first    # prompt-first | enforce
        allowReadOnlyShell: true  # obvious read-only ops_bash calls bypass approval
        gatedTools: []            # override the brake list; 'write*' matches prefixes
        approvalTtlMinutes: 120   # safety TTL; a new turn invalidates immediately
        cleanup: true             # register the postwork_cleanup tool
        maxCleanupPerRun: 50      # files sent to the Recycle Bin per run
```

`order: 400` sits ahead of the built-in plan policy (500) and every tool
guidance section (1000+). Raise it if you want the gate to be less prominent.

`strictness`:

| Value | Behaviour |
| --- | --- |
| `adaptive` (default) | Clear, low-risk, reversible one-step changes: restate and ask once. Everything else: full four-step list. |
| `always` | Full four-step list for every task, no size-based shortcut. |
| `strict` | Full four-step list, at least two clarifying questions, mandatory risk and rollback columns, and an explicit A/B choice for “you decide”. |

`gateMode`:

| Value | When approval is unavailable or policy is `never` |
| --- | --- |
| `prompt-first` (default) | Allow the call and log one degradation warning in the Host log. |
| `enforce` | Deny the write instead of silently running without an approval channel. |

## Tools

| Tool | Purpose |
| --- | --- |
| `prework_plan` | Register this turn's checklist and close the brake; the plan text is shown in the approval dialog. |
| `postwork_cleanup` | Scan this session's records; `paths` adds report-only candidates, `dryRun: true` never deletes. |

`postwork_cleanup` grades every candidate:

- **Auto-remove to Recycle Bin**: files explicitly created by this session under the OS temp root, below 200 MB.
- **Report only**: workspace files, modified files, `.bak` / `.old` / `.orig` backups, directories, files at or above 200 MB, and caller-supplied `paths`.
- **Never auto-remove**: `present` deliverables, `.git`, symlinks/junctions, `~/.dsh`, common user-data folders, and system directories.

Removal uses the Windows Recycle Bin (`Microsoft.VisualBasic.FileIO`) and falls back to `%TEMP%\prework-gate-trash\<timestamp>-<random>\`. The fallback uses Node `fs` APIs rather than `cmd` or an external `mv`; failures leave the original in place and are reported.

## Command gate

`ops_bash` is gated by default, but clearly read-only commands bypass approval:

- Allowed: `pwd`, `ls`, `git status`, `git diff`, `git log`, `git show`, `Get-ChildItem`, `Get-Content`, `Get-Command`, `Test-Path`, version queries, and similar read-only forms.
- Gated: script paths, pipelines/redirection/chaining, delete/move/install/build commands, Git writes, `git diff --output`, and anything whose read-only nature cannot be established.
- This is not a shell sandbox. It only removes routine approval noise for common read-only queries; unknown commands are treated conservatively.

## Verify

```bash
node test/run.mjs
```

Nineteen checks cover prompt blocks, tool schemas, per-turn re-arming, stale approvals, rejection/cancellation, `never` policy, both fail modes, shell classification, cleanup provenance/deliverable/backup protection, failed-write exclusion, move-destination tracking, relative-path resolution, and cleanup approval.

## Limitations

- `prompt-first` still allows writes when approval policy is `never` or the approval service is unavailable. Use `gateMode: enforce` when you need a closed failure mode.
- Command classification is an explicit allow-list. Complex scripts, dynamic commands, and nested shells are gated rather than deeply analysed.
- `gatedTools` can override the default list; removing `ops_bash` removes command-level protection.
- Cleanup sees only paths explicitly created by this session plus report-only `paths`; it does not scan historical junk.
- The section adds roughly 1–2 K characters to every request.

## License

MIT.
