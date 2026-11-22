import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CallStatus, ReaCall } from '../types'

// rea-desk: a working desk for REA (Reverse Engineer Anything) sessions.
//  - Scope guard: REA calls that name a path outside the folders you set with
//    /rea-scope are refused, so the agent stays on software you are allowed
//    to analyze.
//  - Focus: /rea-focus names the one feature under investigation; the agent
//    is reminded of it in its system prompt.
//  - Ledger pane: every REA call with its targets, outcome and duration.
//  - Case files: per-target history kept across sessions (/rea-case).

const PANE = 'rea-desk'
const MAX_CALLS = 300
const MAX_CASES = 200

const calls = atom({ plugin: 'rea-desk', key: 'calls' } as const, [], {
  shape: 'calls-1',
})
const scope = atom({ plugin: 'rea-desk', key: 'scope' } as const, [], {
  shape: 'scope-1',
})
const focus = atom({ plugin: 'rea-desk', key: 'focus' } as const, '', {
  shape: 'focus-1',
})

// Module variables reset on reload; they only cache what $.store holds.
let projectKey = ''
let warnedNoScope = false

type CaseFile = {
  target: string
  firstSeen: number
  lastSeen: number
  calls: number
  errors: number
  blocked: number
  tools: Record<string, number>
  focuses: string[]
}

// ---------- pure helpers ----------

/** REA's MCP tools: `mcp__rea__*` (setup) or `mcp__plugin_rea_rea__*` (plugin). */
export const isReaMcpTool = (tool: string): boolean =>
  /^mcp__(?:plugin_rea_)?rea__/.test(tool)

const REA_CLI = /(?:^|[\s;&|(])(?:npx\s+(?:-y\s+|--yes\s+)?)?(?:rea|rea-agents)(?:@[\w.\-]+)?(?=\s|$)/

/** A Bash command that runs the REA CLI. */
export const isReaCli = (command: string): boolean => REA_CLI.test(command)

export const shortTool = (tool: string): string =>
  tool.replace(/^mcp__(?:plugin_rea_)?rea__/, '')

const looksAbsolute = (s: string): boolean =>
  /^\//.test(s) || /^[A-Za-z]:[\\/]/.test(s) || /^~[\\/]/.test(s) || /^file:\/\//.test(s)

/** Normalize a path for comparison: forward slashes, no `.`/`..`, no trailing slash. */
export const normalizePath = (raw: string): string => {
  let p = raw.trim().replace(/^file:\/\//, '').replace(/\\/g, '/')
  let prefix = ''
  const drive = /^([A-Za-z]):\//.exec(p)
  if (drive) {
    prefix = `${drive[1]!.toLowerCase()}:`
    p = p.slice(2)
  } else if (p.startsWith('~/')) {
    prefix = '~'
    p = p.slice(1)
  }
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }

  return `${prefix}/${out.join('/')}`
}

export const isInside = (path: string, roots: readonly string[]): boolean => {
  const p = normalizePath(path)

  return roots.some(r => {
    const root = normalizePath(r)

    return root === '/' || p === root || p.startsWith(`${root}/`)
  })
}

/** Absolute paths anywhere in a tool's arguments. */
export const pathsInArgs = (value: unknown, depth = 0): string[] => {
  if (depth > 6) return []
  if (typeof value === 'string') {
    return value.length < 4096 && !value.includes('\n') && looksAbsolute(value)
      ? [value]
      : []
  }
  if (Array.isArray(value)) return value.flatMap(v => pathsInArgs(v, depth + 1))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      k === 'tool' || k === 'tool_use_id' || k === 'consent'
        ? []
        : pathsInArgs(v, depth + 1),
    )
  }

  return []
}

/** Absolute paths in a shell command line (quoted or bare words). */
export const pathsInCommand = (command: string): string[] =>
  (command.match(/"[^"]*"|'[^']*'|[^\s;&|()<>]+/g) ?? [])
    .map(w => w.replace(/^["']|["']$/g, '').replace(/^--?[\w-]+=/, ''))
    .filter(looksAbsolute)

const unique = (xs: string[]): string[] => [...new Set(xs)]

const baseName = (p: string): string => {
  const n = normalizePath(p)

  return n.slice(n.lastIndexOf('/') + 1) || n
}

const seconds = (ms?: number): string =>
  ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`

const MARK: Record<CallStatus, string> = {
  runs: 'runs ',
  ok: 'ok   ',
  error: 'error',
  blocked: 'BLOCK',
}

// ---------- store ----------

const scopeKey = () => `scope:${projectKey}`
const focusKey = () => `focus:${projectKey}`
const caseKey = (target: string) => `case:${normalizePath(target)}`

const saveScope = async ($: EngineInterface, roots: string[]) => {
  await update($, scope, () => roots)
  await $.store.set(scopeKey(), roots)
}

const touchCase = async (
  $: EngineInterface,
  target: string,
  tool: string,
  status: CallStatus,
  now: number,
  currentFocus: string,
) => {
  const key = caseKey(target)
  const was = (await $.store.get(key)) as CaseFile | undefined
  const file: CaseFile = was ?? {
    target: normalizePath(target),
    firstSeen: now,
    lastSeen: now,
    calls: 0,
    errors: 0,
    blocked: 0,
    tools: {},
    focuses: [],
  }
  file.lastSeen = now
  file.calls += 1
  if (status === 'error') file.errors += 1
  if (status === 'blocked') file.blocked += 1
  const name = shortTool(tool)
  file.tools[name] = (file.tools[name] ?? 0) + 1
  if (currentFocus && !file.focuses.includes(currentFocus)) {
    file.focuses = [...file.focuses, currentFocus].slice(-10)
  }
  await $.store.set(key, file)

  // Keep the store bounded: drop the oldest case files past the cap.
  const keys = ((await $.store.keys()) as string[]).filter(k => k.startsWith('case:'))
  if (keys.length > MAX_CASES) {
    for (const k of keys.slice(0, keys.length - MAX_CASES)) await $.store.delete(k)
  }
}

const listCases = async ($: EngineInterface): Promise<CaseFile[]> => {
  const keys = ((await $.store.keys()) as string[]).filter(k => k.startsWith('case:'))
  const files: CaseFile[] = []
  for (const k of keys) {
    const f = (await $.store.get(k)) as CaseFile | undefined
    if (f) files.push(f)
  }

  return files.sort((a, b) => b.lastSeen - a.lastSeen)
}

const refreshStatus = async ($: EngineInterface) => {
  const list = await read($, calls)
  const roots = await read($, scope)
  const f = await read($, focus)
  if (list.length === 0 && roots.length === 0 && !f) {
    $.ui.status(undefined)

    return
  }
  const bits = [
    `REA ${list.length} call${list.length === 1 ? '' : 's'}`,
    roots.length ? `scope ${roots.length}` : 'scope unset',
  ]
  if (f) bits.push(`focus: ${f.slice(0, 30)}`)
  $.ui.status(bits.join(' · '))
}

// ---------- the guard and ledger ----------

const track = async (
  $: EngineInterface,
  e: { tool: string; tool_use_id: string },
  targets: string[],
  next: () => Promise<any>,
) => {
  const roots = await read($, scope)
  const currentFocus = await read($, focus)
  const startedAt = await $.clock.now()
  const call: ReaCall = {
    id: e.tool_use_id,
    tool: e.tool,
    targets,
    status: 'runs',
    startedAt,
  }

  const outside = roots.length ? targets.filter(t => !isInside(t, roots)) : []
  if (outside.length) {
    call.status = 'blocked'
    call.note = `outside scope: ${outside.join(', ')}`
    await update($, calls, list => [...list, call].slice(-MAX_CALLS))
    for (const t of targets) await touchCase($, t, e.tool, 'blocked', startedAt, currentFocus)
    await refreshStatus($)

    return {
      deny:
        `rea-desk: ${outside.join(', ')} is outside the authorized REA scope ` +
        `(${roots.join(', ')}). Do not retry or work around this. Ask the person ` +
        `to confirm they own or are authorized to analyze it and to run ` +
        `/rea-scope add <folder> if so.`,
    }
  }

  if (!roots.length && !warnedNoScope) {
    warnedNoScope = true
    $.ui.toast('REA is running with no scope set. Use /rea-scope add <folder> to limit it.')
  }

  await update($, calls, list => [...list, call].slice(-MAX_CALLS))
  await refreshStatus($)

  let status: CallStatus = 'ok'
  let ran: any
  try {
    ran = await next()
    status = ran?.deny !== undefined ? 'blocked' : ran?.isError ? 'error' : 'ok'
  } catch (err) {
    status = 'error'
    throw err
  } finally {
    const ms = (await $.clock.now()) - startedAt
    await update($, calls, list =>
      list.map(one => (one.id === call.id ? { ...one, status, ms } : one)),
    )
    for (const t of targets) await touchCase($, t, e.tool, status, startedAt, currentFocus)
    await refreshStatus($)
  }

  return ran
}

// ---------- commands ----------

const COMMANDS = [
  { name: 'rea-desk', description: 'Open the REA desk: scope, focus and the evidence ledger' },
  { name: 'rea-scope', description: 'Show or set the folders REA may analyze: add <dir> | remove <dir> | clear' },
  { name: 'rea-focus', description: 'Set the one feature under investigation (or "clear")' },
  { name: 'rea-case', description: 'List REA case files across sessions, or show one: /rea-case <path>' },
  { name: 'rea-handoff', description: 'Hand the REA findings to the build phase (spec, TDD, review with mattpocock/skills)' },
]

const commandFailed = () => ({ text: 'rea-desk: that command failed.' })

const scopeText = (roots: readonly string[]) =>
  roots.length
    ? `REA scope:\n${roots.map(r => `  ${r}`).join('\n')}`
    : 'REA scope is not set: REA calls are allowed but not checked. Use /rea-scope add <folder>.'

const runScope = async ($: EngineInterface, args: string) => {
  const roots = await read($, scope)
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const arg = rest.join(' ').replace(/^["']|["']$/g, '')

  if (verb === '' || verb === 'show') return scopeText(roots)
  if (verb === 'clear') {
    await saveScope($, [])
    await refreshStatus($)

    return 'REA scope cleared.'
  }
  if (verb === 'remove') {
    const n = normalizePath(arg)
    await saveScope($, roots.filter(r => r !== n))
    await refreshStatus($)

    return scopeText(await read($, scope))
  }
  const path = verb === 'add' ? arg : args.trim().replace(/^["']|["']$/g, '')
  if (!looksAbsolute(path)) return 'Give an absolute folder: /rea-scope add /path/to/target'
  const n = normalizePath(path)
  await saveScope($, unique([...roots, n]))
  await refreshStatus($)

  return scopeText(await read($, scope))
}

const runCase = async ($: EngineInterface, args: string) => {
  const files = await listCases($)
  if (files.length === 0) return 'No REA case files yet.'
  const want = args.trim()
  if (!want) {
    return [
      'REA case files (most recent first):',
      ...files.slice(0, 15).map(
        f => `  ${f.target}  ${f.calls} calls, ${f.errors} errors, last ${new Date(f.lastSeen).toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      ),
    ].join('\n')
  }
  const n = normalizePath(want)
  const f = files.find(x => x.target === n) ?? files.find(x => x.target.includes(want))
  if (!f) return `No case file for ${want}.`
  const tools = Object.entries(f.tools)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => `${t} ×${c}`)
    .join(', ')

  return [
    `Case: ${f.target}`,
    `  first seen ${new Date(f.firstSeen).toISOString().slice(0, 10)}, last ${new Date(f.lastSeen).toISOString().slice(0, 10)}`,
    `  ${f.calls} calls, ${f.errors} errors, ${f.blocked} blocked`,
    `  tools: ${tools || 'none'}`,
    `  focuses: ${f.focuses.join('; ') || 'none'}`,
  ].join('\n')
}

// The build phase: after REA has the evidence, the mattpocock/skills set
// (https://github.com/mattpocock/skills) takes over forward engineering.
const PIPELINE = [
  '1. Stress-test the reconstruction design: /grill-with-docs (or /grill-me) until gaps and terms are settled; /domain-modeling for the vocabulary.',
  '2. Formalize: /to-spec, then /to-tickets for trackable work.',
  '3. Build: /tdd or /implement-spec, red-green-refactor against the spec.',
  '4. Review: /code-review (standards + spec compliance).',
  '5. Refine or pass on: /improve-codebase-architecture, /handoff.',
]

const POCOCK_INSTALL =
  'Not installed? Claude Code: claude plugin install mattpocock-skills@claude-plugins-official, ' +
  'then run /setup-matt-pocock-skills once in the repo you build in.'

const runHandoff = async ($: EngineInterface, args: string) => {
  const roots = await read($, scope)
  const f = await read($, focus)
  const list = await read($, calls)
  const cases = await listCases($)
  const want = args.trim()
  const targets = unique(list.flatMap(c => c.targets).map(normalizePath))
  const relevant = want
    ? cases.filter(c => c.target.includes(want))
    : cases.filter(c => targets.includes(c.target)).slice(0, 5)

  const brief = [
    '# REA handoff to the build phase',
    `Feature under investigation: ${f || '(no focus set; ask the person which feature to rebuild)'}`,
    `Authorized scope: ${roots.join(', ') || '(not set)'}`,
    'Targets investigated:',
    ...(relevant.length
      ? relevant.map(c => `  - ${c.target}: ${c.calls} REA calls (${c.errors} errors), tools ${Object.keys(c.tools).join(', ')}`)
      : ['  - none recorded']),
    '',
    'Clean-room rule: build from the behaviour and evidence REA established, not by copying decompiled code. ' +
      'Carry each requirement back to its Evidence, and list the unknowns REA reported as open questions.',
    '',
    'Pipeline:',
    ...PIPELINE,
  ].join('\n')

  return {
    text: `${brief}\n\n${POCOCK_INSTALL}`,
    context: [
      `${brief}\n\nStart with step 1 now: summarize the REA evidence for this feature as requirements with sources and open questions, then grill the design with the person before writing code.`,
    ],
  }
}

// ---------- register ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    projectKey = normalizePath(e.cwd ?? '/')
    const savedScope = (await $.store.get(scopeKey())) as string[] | undefined
    const savedFocus = (await $.store.get(focusKey())) as string | undefined
    if (Array.isArray(savedScope)) await update($, scope, () => savedScope)
    if (typeof savedFocus === 'string') await update($, focus, () => savedFocus)
    for (const c of COMMANDS) await $.command.register(c)
    await refreshStatus($)

    return next(e)
  })

  on('command.run', { command: 'rea-desk' }, async $ => {
    await $.ui.open({ id: PANE, title: 'REA desk' })

    return { text: 'REA desk opened.' }
  }).catch(commandFailed)

  on('command.run', { command: 'rea-scope' }, async ($, e) => ({
    text: await runScope($, (e.args ?? '')),
  })).catch(commandFailed)

  on('command.run', { command: 'rea-focus' }, async ($, e) => {
    const text = (e.args ?? '').trim()
    const value = text === 'clear' ? '' : text
    if (!text) {
      const f = await read($, focus)

      return { text: f ? `REA focus: ${f}` : 'No REA focus set. /rea-focus <feature>' }
    }
    await update($, focus, () => value)
    await $.store.set(focusKey(), value)
    await refreshStatus($)

    return { text: value ? `REA focus set: ${value}` : 'REA focus cleared.' }
  }).catch(commandFailed)

  on('command.run', { command: 'rea-case' }, async ($, e) => ({
    text: await runCase($, (e.args ?? '')),
  })).catch(commandFailed)

  on('command.run', { command: 'rea-handoff' }, async ($, e) =>
    runHandoff($, e.args ?? ''),
  ).catch(commandFailed)

  on('tool.call', async ($, e, next) => {
    if (isReaMcpTool(e.tool)) {
      return track($, e, unique(pathsInArgs(e)), () => next(e))
    }
    if (e.tool === 'Bash' && typeof e.command === 'string' && isReaCli(e.command)) {
      return track($, e, unique(pathsInCommand(e.command)), () => next(e))
    }

    return next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'rea-desk: its scope guard failed; not running the REA call.' },
  )

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const roots = await read($, scope)
    const f = await read($, focus)
    if (!roots.length && !f) return composed
    const lines = ['# REA desk']
    if (roots.length) {
      lines.push(
        `The person has authorized REA analysis only inside: ${roots.join(', ')}. ` +
          'REA calls naming paths outside these folders are refused by the rea-desk mod; ' +
          'do not retry them or route around the guard, ask the person instead.',
      )
    }
    if (f) {
      lines.push(
        `Current REA focus: "${f}". Keep investigation to this one feature; ` +
          'ask before widening it, since broad REA sweeps cost much more time.',
      )
    }

    return {
      sections: [
        ...composed.sections,
        { id: 'rea-desk:scope', text: lines.join('\n'), scope: 'session' as const },
      ],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, calls)
    const roots = await read($, scope)
    const f = await read($, focus)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 8)
    const counts = { ok: 0, error: 0, blocked: 0 }
    for (const c of list) if (c.status !== 'runs') counts[c.status] += 1

    return (
      <Box flexDirection="column">
        <Text bold>Scope</Text>
        {roots.length === 0 && <Text dimColor>not set: REA calls are not checked</Text>}
        {roots.map(r => (
          <Text>  {r}</Text>
        ))}
        <Text bold>Focus</Text>
        <Text dimColor={!f}>  {f || 'none (/rea-focus <feature>)'}</Text>
        <Text bold>
          Ledger: {list.length} calls, {counts.ok} ok, {counts.error} errors, {counts.blocked} blocked
        </Text>
        {list.length === 0 && <Text dimColor>No REA calls yet.</Text>}
        {list.slice(-room).map(c => (
          <Text dimColor={c.status === 'ok'} color={c.status === 'blocked' || c.status === 'error' ? 'red' : undefined}>
            {MARK[c.status]} {shortTool(c.tool)} {c.targets.map(baseName).join(', ')} {seconds(c.ms)}
          </Text>
        ))}
      </Box>
    )
  })
}
