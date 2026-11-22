import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'rea-desk',
  component: 'Pane',
  requestId: 'rea-desk',
  props: {
    title: 'REA desk',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const REA_TOOL = 'mcp__rea__analyze_javascript_application'

const setup = async ($: any, on: any) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on)
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: { ok: true } }))
  await $.session.start({ cwd: '/work/proj', surface: 'desktop', isInteractive: true })
}

test('a REA call outside the scope is refused, one inside runs', async ($, on) => {
  await setup($, on)
  const set = await $.command.run({ command: 'rea-scope', args: 'add /apps/mine' })
  expect(set.text).toContain('/apps/mine')

  const outside = await $.tool.call({ tool: REA_TOOL, path: '/apps/theirs/app.asar' })
  expect(String(outside.deny)).toContain('outside the authorized REA scope')

  const inside = await $.tool.call({ tool: REA_TOOL, path: '/apps/mine/sub/../app.asar' })
  expect(inside.deny).toBeUndefined()

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Ledger/ }))?.text).toContain('1 ok')
    expect((await ui.find({ type: 'Text', text: /BLOCK/ }))?.text).toContain('app.asar')
    await ui.unmount()
  }
})

test('the REA CLI through Bash is guarded too; other tools are untouched', async ($, on) => {
  await setup($, on)
  await $.command.run({ command: 'rea-scope', args: '/apps/mine' })

  const cli = await $.tool.call({
    tool: 'Bash',
    command: 'npx -y rea-agents@latest analyze-javascript-application "/etc/other" --json',
  })
  expect(String(cli.deny)).toContain('/etc/other')

  const plain = await $.tool.call({ tool: 'Bash', command: 'ls /etc/other' })
  expect(plain.deny).toBeUndefined()
})

test('no scope set: calls run and land in a case file with the focus', async ($, on) => {
  await setup($, on)
  await $.command.run({ command: 'rea-focus', args: 'search indexing' })
  await $.tool.call({ tool: 'mcp__plugin_rea_rea__binary_session', target: '/bin/notes' })
  await $.tool.call({ tool: 'mcp__plugin_rea_rea__binary_session', target: '/bin/notes' })

  const list = await $.command.run({ command: 'rea-case' })
  expect(list.text).toContain('/bin/notes  2 calls')
  const one = await $.command.run({ command: 'rea-case', args: '/bin/notes' })
  expect(one.text).toContain('binary_session ×2')
  expect(one.text).toContain('search indexing')
})

test('the handoff brief names the focus, the target and the build pipeline', async ($, on) => {
  await setup($, on)
  await $.command.run({ command: 'rea-focus', args: 'clipboard bridge' })
  await $.tool.call({ tool: REA_TOOL, path: '/apps/mine/app.asar' })

  const out = await $.command.run({ command: 'rea-handoff' })
  expect(out.text).toContain('clipboard bridge')
  expect(out.text).toContain('/apps/mine/app.asar')
  expect(out.text).toContain('/to-spec')
  expect(out.context?.[0]).toContain('grill the design')
})
