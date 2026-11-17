# dsh-prework-gate

A DeepSeek Harness (DSH) profile plugin: **ask first, plan second, act last.**

Adds one high-priority system-prompt section, so that in every session of the
profile the agent:

1. clarifies requirements (goal, scope, constraints, acceptance) with up to four
   questions, and answers by itself whatever it can check read-only;
2. researches existing options and the current state before proposing anything;
3. publishes an execution list — steps, blast radius, risk, rollback, open
   decisions — and asks for confirmation;
4. starts working only after an explicit approval, and re-confirms anything
   outside the approved list.

Plain read-only questions, one-line typo fixes, and turns where the user already
gave a full spec plus "just do it" stay exempt.

## Install

Host-only bundle, no dependencies, no build step.

1. In DSH open **Plugins**, choose **Add plugin**, and pick this directory; or
   install it with the `plugin_manager` tool (`action: install_bundle`, target =
   absolute path to this directory).
2. The row appears as **开工闸门 / Prework gate**. Turn it off with
   `enabled: false` in `cordis.patch.yml`, or from **Plugins**.

Restarting is not required for a fresh install that activates over HMR; a
replacement of the package needs a restart.

## Configuration

```yaml
- insert:
    - id: prework-gate
      name: 'dsh-prework-gate'
      config:
        enabled: true          # false = register nothing at all
        order: 400             # prompt position; smaller = earlier and stronger
        strictness: adaptive   # adaptive | always | strict
        extraRules: []         # extra constraint lines appended to the section
```

`order: 400` sits ahead of the built-in plan policy (500) and every tool
guidance section (1000+). Raise it if you want the gate to be less prominent.

`strictness`:

| Value | Behaviour |
| --- | --- |
| `adaptive` (default) | Small, single-file, reversible change: restate the request and ask once. Anything else: full four-step list. |
| `always` | Full four-step list for every task, no size-based shortcut. |
| `strict` | Full four-step list, at least two clarifying questions, risk and rollback columns mandatory, and "you decide" becomes an explicit A/B choice. |

The whole prompt text lives in `index.js` (`BASE_RULES` and `MODES`), so you can
edit the wording and reinstall, or append project-specific rules through
`extraRules`.

## Verify

Start a new session and send something ordinary like "帮我改一下配置", or ask the
agent to change a file. It should restate the request and ask before writing.

## Limitations

- The gate is prompt-level, not a hard interceptor: it strongly biases the agent
  toward asking, but it cannot physically block a tool call. Pair it with
  approval modes or a guard plugin if you need enforcement.
- It adds a few hundred tokens to every request's system prompt.

## License

MIT.
