/**
 * Lightweight TUI copy: a zh/en dictionary with `DSH_TUI_LANG` resolution
 * (default English so terminals without a locale stay readable). Copy that
 * changes behavior between locales is a bug; tests pin both sides.
 */

/** The supported interface languages. */
export type TuiLocaleName = 'en' | 'zh'

/** One translation entry per language. */
type TuiDict = Record<string, string>

/** English copy (default). */
const EN: TuiDict = {
  'welcome.title': 'dshcli — DeepSeek Harness in your terminal',
  'welcome.start': 'type a message to start a new session',
  'welcome.keys': 'Ctrl+N new session · / commands · Tab views',
  'welcome.keys2': 'Ctrl+X model · Ctrl+O tool card · Ctrl+E settings file · Ctrl+Q quit',
  'transcript.contextUnit': '{marker} {preview} · {lines} lines',
  'transcript.copied': 'Copied {chars} characters to the clipboard',
  'hint.noSession': 'No session — press Ctrl+N to start',
  'hint.newSession': 'New session — type a message below',
  'hint.search': 'search:',
  'status.model': 'model',
  'status.cache': 'cache',
  'status.resumedOpenTurn': 'Session resumed — the last turn was interrupted; send a message to continue',
  'compact.offerHeavy': 'Large context (~{tokens} tokens): continuing re-sends it every request (cache misses cost more). Compact first? [y] compact [n] continue',
  'compact.done': '{text}',
  'compact.failed': 'Compaction failed: {text}',
  'compact.unavailable': 'Compaction is not available here.',
  'approval.title': 'Approval required',
  'approval.hint': '[y] allow once    [n] reject    [a] always allow    [Esc] cancel',
  'question.title': 'Question',
  'question.empty': '(no questions)',
  'question.hint': '↑/↓ choose    [Enter] answer    [Esc] dismiss',
  'commands.title': 'Commands',
  'commands.empty': '(no matches)',
  'palette.views': 'Views',
  'palette.actions': 'Actions',
  'palette.commands': 'Commands',
  'model.title': 'Select model',
  'model.catalogPartial': '{count} model provider(s) could not be listed; healthy providers remain available.',
  'jobs.empty': '(no jobs)',
  'jobs.killed': 'Job {id}: {result}',
  'jobs.action.details': 'details',
  'jobs.action.kill': 'kill',
  'jobs.confirmKill': 'Kill job {id}?',
  'subagents.empty': '(no subagents)',
  'session.subagentReadOnly': 'Session {id} is owned by subagent routing and is observation-only here.',
  'goals.empty': '(no goal)',
  'goal.action.resume': 'resume',
  'goal.action.pause': 'pause',
  'goal.action.complete': 'complete',
  'goal.action.clear': 'clear',
  'goal.resumed': 'Goal resumed.',
  'goal.resumeFailed': 'Goal resume failed: {error}',
  'goal.paused': 'Goal paused.',
  'goal.completed': 'Goal completed.',
  'goal.cleared': 'Goal cleared.',
  'goal.actionFailed': 'Goal action failed: {error}',
  'confirm.title': 'Confirm',
  'confirm.hint': '[y] yes    [n] no    [Esc] cancel',
  'confirm.completeGoal': 'Complete goal "{objective}"?',
  'confirm.clearGoal': 'Clear goal "{objective}"?',
  'settings.empty': '(no settings)',
  'settings.file': 'settings file: {path}',
  'settings.editHint': 'edit the file yourself — Ctrl+E opens it in your editor',
  'settings.updateFailed': 'Setting {label} update failed: {error}',
  'settings.editorOpened': 'Settings document opened in your editor: {path}',
  'settings.editorUnavailable': 'No settings document is editable here.',
  'settings.editorFailed': 'Opening the settings document failed: {error}',
  'lang.title': 'Language',
  'lang.selected': 'Language: {name}',
  'mode.title': 'Permission mode',
  'mode.current': '(current)',
  'mode.unavailable': 'No permission presets are available.',
  'mode.selected': 'Permission mode: {preset}',
  'mode.defaultSelected': 'Permission mode for new sessions: {preset}',
  'nav.sessions': 'session list',
  'nav.jobs': 'background jobs',
  'nav.subagents': 'subagent tree',
  'nav.skills': 'skill catalog',
  'nav.help': 'key bindings',
  'nav.model': 'switch model',
  'nav.mode': 'switch permission mode',
  'nav.lang': 'switch language',
  'nav.new': 'new session',
  'nav.exit': 'quit',
  'host.compact': 'compact older conversation history',
  'host.goal': 'set or view the goal',
  'host.plan': 'enter or leave plan mode',
  'host.feedback': 'record feedback about this session',
  'skills.empty': '(no skills)',
  'skill.invoked': 'Loaded skill "{name}" into the conversation.',
  'skill.notUserInvocable': 'Skill "{name}" is not user-invocable.',
  'skill.loadFailed': 'Skill "{name}" failed to load: {error}',
  'command.unknown': 'Unknown command: {line}',
  'command.failed': 'Command failed: {error}',
  'mention.title': 'Reference',
  'mention.empty': '(no matches)',
  'mention.fileNotFound': 'File not found: {path}',
  'mention.fileTooLarge': 'File too large to attach: {path}',
  'mention.tooMuch': 'Reference budget exceeded; skipped: {path}',
  'mention.tooMany': 'Too many references; only the first {max} attach',
  'model.selected': 'Model: {model}',
  'help.title': 'dshcli — terminal UI for the DeepSeek Harness',
  'help.views': 'Tab cycle views ({views}) · Esc back to the conversation',
  'help.section.views': 'Views',
  'help.section.palette': 'Palette',
  'help.section.composer': 'Composer',
  'help.section.mention': 'Mention',
  'help.section.scroll': 'Scroll',
  'help.section.settings': 'Settings',
  'help.section.viewKeys': 'Views detail',
  'help.line.tab': 'Tab — cycle views',
  'help.line.esc': 'Esc — back to the conversation',
  'help.line.enter': 'Enter — send / expand the last tool card',
  'help.line.ctrlC': 'Ctrl+C — cancel / clear, twice quits',
  'help.line.edit': 'Ctrl+A/U/K — edit the draft',
  'help.line.history': '↑/↓ — draft history · Tab — complete',
  'help.line.mention': '@path — attach a file · @skill — load a skill · Tab completes · Enter sends',
  'help.line.scrollPg': 'PgUp/PgDn — ten rows',
  'help.line.scrollRow': 'Ctrl+↑/↓ — one row',
  'help.line.wheel': 'wheel — three rows',
  'help.line.settingsEdit': 'Ctrl+E — edit the settings file',
  'help.line.settingsBack': 'Esc — back to the conversation',
  'help.line.viewSessions': 'sessions — type to filter · Enter opens',
  'help.line.viewJobs': 'jobs — Enter actions · kill confirms',
  'help.line.viewGoals': 'goals — Enter actions · complete/clear confirm',
  'exit.cancel': 'Cancelling the active turn before exit…',
  'exit.confirmCtrlC': 'Press Ctrl+C again to quit',
  'exit.resumeHint': 'Resume this session: dshcli --resume {id}',
}

/** Chinese copy (web product copy is Chinese; mirrors it). */
const ZH: TuiDict = {
  'welcome.title': 'dshcli — DeepSeek Harness 终端界面',
  'welcome.start': '输入消息开始新会话',
  'welcome.keys': 'Ctrl+N 新会话 · / 命令 · Tab 视图',
  'welcome.keys2': 'Ctrl+X 模型 · Ctrl+O 工具卡 · Ctrl+E 设置文件 · Ctrl+Q 退出',
  'transcript.contextUnit': '{marker} {preview} · {lines} 行',
  'transcript.copied': '已复制 {chars} 个字符到剪贴板',
  'hint.noSession': '无会话 — 按 Ctrl+N 开始',
  'hint.newSession': '新会话 — 输入消息开始',
  'hint.search': '搜索:',
  'status.model': '模型',
  'status.cache': '缓存',
  'status.resumedOpenTurn': '会话已恢复 — 上一回合被中断；发送消息以继续',
  'compact.offerHeavy': '此会话上下文较大（约 {tokens} tokens）。继续会每次请求重复发送，缓存未命中成本更高。先压缩？[y] 压缩 [n] 继续',
  'compact.done': '{text}',
  'compact.failed': '压缩失败：{text}',
  'compact.unavailable': '此处无法压缩。',
  'approval.title': '需要审批',
  'approval.hint': '[y] 允许一次    [n] 拒绝    [a] 始终允许    [Esc] 取消',
  'question.title': '提问',
  'question.empty': '（无问题）',
  'question.hint': '↑/↓ 选择    [Enter] 回答    [Esc] 关闭',
  'commands.title': '命令',
  'commands.empty': '（无匹配）',
  'palette.views': '视图',
  'palette.actions': '动作',
  'palette.commands': '命令',
  'model.title': '选择模型',
  'model.catalogPartial': '{count} 个模型提供方无法列出；其他可用提供方仍可选择。',
  'jobs.empty': '（无任务）',
  'jobs.killed': '任务 {id}：{result}',
  'jobs.action.details': '详情',
  'jobs.action.kill': '终止',
  'jobs.confirmKill': '终止任务 {id}？',
  'subagents.empty': '（无子智能体）',
  'session.subagentReadOnly': '会话 {id} 由子智能体路由管理，此处仅供观察。',
  'goals.empty': '（无目标）',
  'goal.action.resume': '继续',
  'goal.action.pause': '暂停',
  'goal.action.complete': '完成',
  'goal.action.clear': '清除',
  'goal.resumed': '目标已继续。',
  'goal.resumeFailed': '继续目标失败：{error}',
  'goal.paused': '目标已暂停。',
  'goal.completed': '目标已完成。',
  'goal.cleared': '目标已清除。',
  'goal.actionFailed': '目标操作失败：{error}',
  'confirm.title': '确认',
  'confirm.hint': '[y] 是    [n] 否    [Esc] 取消',
  'confirm.completeGoal': '完成目标 "{objective}"？',
  'confirm.clearGoal': '清除目标 "{objective}"？',
  'settings.empty': '（无设置）',
  'settings.file': '设置文件：{path}',
  'settings.editHint': '请自行编辑该文件 — Ctrl+E 用你的编辑器打开',
  'settings.updateFailed': '设置 {label} 更新失败：{error}',
  'settings.editorOpened': '已在编辑器中打开设置文件：{path}',
  'settings.editorUnavailable': '这里没有可编辑的设置文件。',
  'settings.editorFailed': '打开设置文件失败：{error}',
  'lang.title': '语言',
  'lang.selected': '语言：{name}',
  'mode.title': '权限模式',
  'mode.current': '（当前）',
  'mode.unavailable': '没有可用的权限预设。',
  'mode.selected': '权限模式：{preset}',
  'mode.defaultSelected': '新会话的权限模式：{preset}',
  'nav.sessions': '会话列表',
  'nav.jobs': '后台任务',
  'nav.subagents': '子智能体树',
  'nav.skills': '技能目录',
  'nav.help': '按键说明',
  'nav.model': '切换模型',
  'nav.mode': '切换权限模式',
  'nav.lang': '切换语言',
  'nav.new': '新会话',
  'nav.exit': '退出',
  'host.compact': '压缩较早的对话历史',
  'host.goal': '设置或查看目标',
  'host.plan': '进入或退出计划模式',
  'host.feedback': '记录本会话的反馈',
  'skills.empty': '（无技能）',
  'skill.invoked': '已把技能 "{name}" 载入会话。',
  'skill.notUserInvocable': '技能 "{name}" 不允许用户调用。',
  'skill.loadFailed': '技能 "{name}" 加载失败：{error}',
  'command.unknown': '未知命令：{line}',
  'command.failed': '命令执行失败：{error}',
  'mention.title': '引用',
  'mention.empty': '（无匹配）',
  'mention.fileNotFound': '文件不存在：{path}',
  'mention.fileTooLarge': '文件过大，未附加：{path}',
  'mention.tooMuch': '引用预算已满，已跳过：{path}',
  'mention.tooMany': '引用过多，只附加前 {max} 个',
  'model.selected': '模型：{model}',
  'help.title': 'dshcli — DeepSeek Harness 终端界面',
  'help.section.views': '视图',
  'help.section.palette': '命令面板',
  'help.section.composer': '输入框',
  'help.section.mention': '引用',
  'help.section.scroll': '滚动',
  'help.section.settings': '设置',
  'help.section.viewKeys': '视图操作',
  'help.line.tab': 'Tab — 循环视图',
  'help.line.esc': 'Esc — 返回对话',
  'help.line.enter': 'Enter — 发送 / 展开最近工具卡',
  'help.line.ctrlC': 'Ctrl+C — 取消 / 清空，连按两次退出',
  'help.line.edit': 'Ctrl+A/U/K — 编辑草稿',
  'help.line.history': '↑/↓ — 草稿历史 · Tab — 补全',
  'help.line.mention': '@路径 — 附加文件 · @技能 — 载入技能 · Tab 补全 · Enter 发送',
  'help.line.scrollPg': 'PgUp/PgDn — 翻十行',
  'help.line.scrollRow': 'Ctrl+↑/↓ — 滚一行',
  'help.line.wheel': '滚轮 — 每格三行',
  'help.line.settingsEdit': 'Ctrl+E — 编辑设置文件',
  'help.line.settingsBack': 'Esc — 返回对话',
  'help.line.viewSessions': '会话 — 输入过滤 · Enter 打开',
  'help.line.viewJobs': '任务 — Enter 动作菜单 · 终止需确认',
  'help.line.viewGoals': '目标 — Enter 动作菜单 · 完成/清除需确认',
  'exit.cancel': '正在取消当前回合后退出…',
  'exit.confirmCtrlC': '再按一次 Ctrl+C 退出',
  'exit.resumeHint': '恢复此会话：dshcli --resume {id}',
}

/** The active dictionary. */
let dict: TuiDict = EN

/** Resolve the locale from `DSH_TUI_LANG`, defaulting to English. */
function resolveLocale(): TuiDict {
  const raw = process.env.DSH_TUI_LANG
  return raw === 'zh' ? ZH : EN
}

/**
 * The active copy's name (exposed for tests).
 * @returns the active locale.
 */
export function localeName(): TuiLocaleName {
  return dict === ZH ? 'zh' : 'en'
}

/**
 * Translate one copy key, interpolating `{name}` placeholders from `values`.
 * @param key - the copy key.
 * @param values - optional placeholder replacements.
 * @returns the active-language text (the key itself when unknown), with any
 *   `{name}` placeholder replaced by its value (unknown values stay verbatim).
 */
export function t(key: string, values: Record<string, string> = {}): string {
  const text = dict[key] ?? key
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    values[name] ?? match)
}

/**
 * Reset the locale from the environment (tests pin both sides).
 */
export function resetLocale(): void {
  dict = resolveLocale()
}

/**
 * Switch the active copy at runtime (the `/lang` picker and the `tui` settings
 * namespace drive this; the environment only supplies the initial default).
 * @param name - the locale to activate.
 */
export function setLocale(name: TuiLocaleName): void {
  dict = name === 'zh' ? ZH : EN
}

/** Re-resolve from `DSH_TUI_LANG` on boot. */
resetLocale()
