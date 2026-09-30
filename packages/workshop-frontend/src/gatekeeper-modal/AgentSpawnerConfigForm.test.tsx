// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { AgentSpawnerConfigForm } from './AgentSpawnerConfigForm'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const models: AiChatAuthorInfo[] = [
  { type: 'agent', id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { type: 'agent', id: 'latest:opus', name: 'Latest Opus (Claude Opus 5.5)' },
]

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function renderForm(modelId: string | null): HTMLDivElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(
    <AgentSpawnerConfigForm
      availableModels={models}
      displayName="Responder"
      modelId={modelId}
      env={[]}
      envError={null}
      onDisplayNameChange={() => {}}
      onModelIdChange={() => {}}
      onEnvChange={() => {}}
    />,
  ))
  return container
}

describe('AgentSpawnerConfigForm', () => {
  it('explains that a Latest alias follows the deployment\'s newest model', () => {
    const form = renderForm('latest:opus')
    expect(form.textContent).toContain('Latest Opus (Claude Opus 5.5)')
    expect(form.textContent).toContain(
      'Uses the newest Opus this deployment offers, and switches automatically when it adds a ' +
      'newer one.')
  })

  it('keeps the no-agent hint for a concrete model', () => {
    const form = renderForm('claude-opus-5-5')
    expect(form.textContent).toContain('Choose "None" to create conversations without an agent.')
    expect(form.textContent).not.toContain('Uses the newest')
  })
})
