# dsh-tui-plugin

A standalone **terminal UI bundle** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): an interactive in-process host surface that runs on top of the official `dsh` base bundle — session list, streaming conversation with light markdown, tool cards, approvals, questions, background jobs, subagents, goals, plan mode, model selection (with reasoning-effort cycling), settings (file editing), skills, and `@` file/skill references.

It is a standard Cordis **bundle plugin** (`cordis.patch.yml` + `tui-runner`/`tui-startup` function plugins). It mounts no Host, HTTP server, or browser — it drives the same `ctx` host services the official Web surface proxies.

## Requirements

- Node `^22.19` or `>=24`
- The official [DeepSeek Harness CLI](https://www.npmjs.com/package/@deepseek-ai/dsh) installed, so the `dsh-base` bundle and the cmdline/exit services exist.

## Install & run

```sh
npm i -g @deepseek-ai/dsh
npm i -g dsh-tui-plugin

dsh --patch dsh-tui-plugin     # boots base + this tui patch
```

The patch layers the terminal runner over the official base. From there the TUI opens in raw mode: `1–8` views, `/` command palette, `@` mentions, mouse selection (copies on release), wheel + `PgUp`/`PgDn` scrolling, `/lang` for 中文.

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
