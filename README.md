# dsh-tui-plugin

A standalone **terminal UI bundle** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): an interactive in-process host surface that runs on top of the official `dsh` base bundle — session list, streaming conversation with light markdown, tool cards, approvals, questions, background jobs, subagents, goals, plan mode, model selection (with reasoning-effort cycling), settings (file editing), skills, and `@` file/skill references.

It is a standard Cordis **bundle plugin** (`cordis.patch.yml` + `tui-runner`/`tui-startup` function plugins). It mounts no Host, HTTP server, or browser — it drives the same `ctx` host services the official Web surface proxies.

## Requirements

- Node `^22.19` or `>=24`
- The official [DeepSeek Harness CLI](https://www.npmjs.com/package/@deepseek-ai/dsh) installed, so the `dsh-base` bundle and the cmdline/exit services exist.

The current compatibility boundary was audited against both the published `0.1.1-rc.2` package
line and the exact August 27 source release, `dsh-v0.1.2-alpha.1`
(`cd5ef8148158c3a752a658978873241fdf8e2bbc`). Compatibility adapters retain the earlier
`0.1.0-rc.6` command and user-question seams. The alpha is not available as a complete npm package
set, so its check deliberately consumes a clean source checkout:

```sh
DSH_HARNESS_ROOT=/path/to/deepseek-harness npm run check:harness:alpha
```

The check fails closed if the checkout is dirty, the tag/commit does not match, or any imported
Harness declaration has moved.

## Install & run

This is a **bundle plugin** for the official `dsh` CLI: install it into a profile's bundle stack, then boot that profile. It layers the terminal runner over the official `dsh-base` bundle.

```sh
npm i -g @deepseek-ai/dsh
npm i -g dsh-tui-plugin

# one-time: create/use a profile and add this bundle to it
dsh plugin --profile tui add dsh-tui-plugin
# (the first `add` creates the `tui` profile; it also installs dsh-base)

# every launch: boot the profile
dsh --profile tui
```

> `dsh --patch <path>` takes a patch *file path*, not a package name. Bundle plugins are loaded by listing the package name in the profile's `dsh.profile.bundles` (which `dsh plugin --profile tui add dsh-tui-plugin` does for you) and installing it with pnpm in the profile directory.

From there the TUI opens in raw mode: `1–8` views, `/` command palette, `@` mentions, mouse selection (copies on release), wheel + `PgUp`/`PgDn` scrolling, `/lang` for 中文.

The status line shows the model route with its reasoning effort (`provider/model · high`), accumulated token usage (`↑in ↓out` plus cache traffic), and while a turn runs, its elapsed time and output rate (`12.3s 45/s`). Resuming an interrupted session clears the stuck running state and shows a "session resumed — send a message to continue" notice instead.

### Session lifecycle & compaction

- The sessions view marks heavy sessions (large accumulated prompt-side context, `◆`) so you can spot the expensive ones at a glance.
- Resuming a heavy session (≥ 40k prompt tokens) offers `/compact` first: continuing would re-send the whole context on every request, missing provider prompt caches and billing full uncached input each time. Press `y` to compact, `n`/`Esc` to continue as-is. `/compact` is also always available from the command palette.

## Build

```sh
npm i && npm run build   # emits lib/ via tsc
```

## Test

```sh
npm test                 # unit suites (key decoder, screen, views, fold, popups,
                         # app state machine, runner wiring, i18n)
```

`tests/real-composition.spec.ts` boots the shipped base + tui patches through the real Loader; it needs the official base patch on disk:

```sh
DSH_BASE_PATCH=/path/to/deepseek-harness/packages/bundle/base/cordis.patch.yml npm test
```

(The official `@deepseek-ai/dsh` package may ship its base patch; point `DSH_BASE_PATCH` at it when it does.)

## Publish checklist

1. **Use the name as-is** — `dsh-tui-plugin` is free on the npm registry (verified), and every reference (`package.json`, `cordis.patch.yml`, `src/`) already matches it. Only if you want a personal scope (e.g. `@your-scope/dsh-tui-plugin`) do you rename — and then also update the two `dsh-tui-plugin` `name:` entries in `cordis.patch.yml` (the patch rows load this package by its own name).
2. **Verify dependency versions** against the registry (`npm view @deepseek-ai/dsh-llm version` etc.) — the ranges here match the day this was scaffolded; the harness moves fast.
3. `npm publish` (with `--provenance` when your registry supports it).
4. Add the `dsh-plugin` GitHub topic on your repository.

## Upgrading

The bundle pins `@deepseek-ai/dsh-*` service APIs that are stable, but official releases occasionally adjust the base patch rows. When a new `@deepseek-ai/dsh` lands, bump the ranges and re-run the composition test against the new base.

## License

MIT — derived from the DeepSeek Harness project (MIT).
