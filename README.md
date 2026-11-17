# dsh-prework-gate

A DeepSeek Harness (DSH) profile plugin: **ask first, plan second, act third — then clear the mess.**

Four parts:

1. **Prompt rules** (`index.js`): a high-priority system-prompt section that makes
   the agent clarify (goal, scope, constraints, acceptance — up to four
   questions), research, publish an execution list, and wait for an explicit
   approval. Plain read-only questions, one-line typo fixes, and turns with a
   full spec plus "just do it" stay exempt.
2. **One-round grilling**: for non-trivial work the agent asks everything it can
   ask *now* — at most four numbered questions, each with a recommended answer —
   then goes straight to the list instead of dripping questions one per turn.
3. **Hard brake** (`lib/gate.js`): an unapproved `write` / `edit` / `apply_patch`
   call is stopped by the Host's `tools/pre-execute` gate and
   routed through the approval dialog. One approval unlocks the rest of the task;
   the next task re-arms it.
4. **Postwork cleanup** (`lib/cleanup.js`): the `postwork_cleanup` tool sends this
   session's temp files, logs and build leftovers to the Recycle Bin while
   refusing to touch deliverables, `.git`, backups and user data.

## Install

Host-only bundle, no dependencies, no build step.

1. In DSH open **Plugins**, choose **Add plugin**, and pick this directory; or
   install it with the `plugin_manager` tool (`action: install_bundle`, target =
   absolute path to this directory).
2. The row appears as **开工闸门 / Prework gate**. Turn it off with
   `enabled: false` in `cordis.patch.yml`, or from **Plugins**.

The new tools load after a DSH restart; prompt-wording changes apply on restart
too.

## Configuration

```yaml
- insert:
    - id: prework-gate
      name: 'dsh-prework-gate'
      config:
        enabled: true           # false = register nothing at all
        order: 400              # prompt position; smaller = earlier and stronger
        strictness: adaptive    # adaptive | always | strict
        extraRules: []          # extra constraint lines appended to the section
        grill: true             # the one-round questioning pass
        gate: true              # the hard brake on write tools
        gatedTools: []          # override the brake list; 'write*' matches prefixes
        approvalTtlMinutes: 120 # how long one approval stays valid
        cleanup: true           # register the postwork_cleanup tool
        maxCleanupPerRun: 50    # files per run
```

`order: 400` sits ahead of the built-in plan policy (500) and every tool
guidance section (1000+). Raise it if you want the gate to be less prominent.

`strictness`:

| Value | Behaviour |
| --- | --- |
| `adaptive` (default) | Small, single-file, reversible change: restate the request and ask once. Anything else: full four-step list. |
| `always` | Full four-step list for every task, no size-based shortcut. |
| `strict` | Full four-step list, at least two clarifying questions, risk and rollback columns mandatory, and "you decide" becomes an explicit A/B choice. |

## Tools

| Tool | Purpose |
| --- | --- |
| `prework_plan` | Register this task's checklist and close the brake again; the plan text is what the approval dialog shows. |
| `postwork_cleanup` | Sweep this session's temp artifacts; `paths` adds candidates, `dryRun: true` only reports. |

`postwork_cleanup` grades every candidate:

- **Auto-remove**: anything under the OS temp root, plus `.tmp` / `.log` / `.swp`
  style names, under 200 MB.
- **Ask, never silent**: `.bak` / `.old` backups, files over 200 MB, directories,
  and workspace files a write tool produced that might be the deliverable.
- **Never touch**: paths registered by `present`, `.git`, symlinks/junctions,
  `~/.dsh` (config and memory), system directories, user data.

Removal uses the Windows Recycle Bin (`Microsoft.VisualBasic.FileIO`) and falls
back to `%TEMP%\prework-gate-trash\<timestamp>\`; every run reports what left, what
stayed, and why.

## Verify

```bash
node test/run.mjs
```

Twelve checks cover the four prompt blocks, tool schemas against the DSH-supported
JSON Schema subset, "ask once → unlock the task → re-arm on the next plan",
rejection turning into a denial, a real temp-file removal, and backups plus
deliverables surviving.

## Limitations

- The brake only prompts when the approval service exists *and* the session's
  approval policy is `ask`. Under `never` — the shipped `danger-full-access`
  preset — it **lifts the brake**, because a dialog that can never grant
  approval would just turn every write into a denial. Switch Permissions to
  `workspace-write` (policy `ask`) to see it work. A missing approval surface or
  a call outside an open turn also fails open.
- Only listed tools are gated: `ops_bash` is not on the list by default (it would
  prompt on every command); add patterns through `gatedTools`.
- Cleanup only sees paths this session registered plus explicit `paths`; it never
  scans the workspace for historical junk.
- The section adds roughly 1–2 K characters to every request.

## License

MIT.
