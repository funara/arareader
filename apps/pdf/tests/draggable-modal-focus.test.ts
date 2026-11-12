import { act, createElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DraggableModal } from '../src/renderer/DraggableModal'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let trigger: HTMLButtonElement

function renderModal(title: string, onClose: () => void, ...children: ReactNode[]) {
  return createElement(
    DraggableModal,
    { onMaskClick: onClose, children: undefined },
    createElement('div', { className: 'pdf-modal-title' }, title),
    ...children,
  )
}

function pressKey(key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  document.activeElement?.dispatchEvent(event)
  return event
}

beforeEach(() => {
  document.body.innerHTML = ''
  trigger = document.createElement('button')
  trigger.textContent = 'Open dialog'
  document.body.append(trigger)
  trigger.focus()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  trigger.remove()
  vi.restoreAllMocks()
})

describe('DraggableModal focus management', () => {
  it('names the dialog, preserves autofocus, handles Escape, and restores the opener', () => {
    const onClose = vi.fn()
    act(() =>
      root.render(
        renderModal(
          'Split PDF',
          onClose,
          createElement('input', { autoFocus: true, 'aria-label': 'Pages' }),
        ),
      ),
    )

    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Split PDF')
    expect(document.activeElement).toBe(container.querySelector('input'))

    const escape = pressKey('Escape')
    expect(escape.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()

    act(() => root.render(null))
    expect(document.activeElement).toBe(trigger)
  })

  it('wraps Tab at both boundaries and ignores hidden file inputs', () => {
    act(() =>
      root.render(
        renderModal(
          'Signature',
          vi.fn(),
          createElement('input', { type: 'file', style: { display: 'none' } }),
          createElement('button', { id: 'first' }, 'First'),
          createElement('button', { id: 'last' }, 'Last'),
        ),
      ),
    )

    const first = container.querySelector<HTMLButtonElement>('#first')!
    const last = container.querySelector<HTMLButtonElement>('#last')!
    expect(document.activeElement).toBe(first)

    trigger.focus()
    const outside = pressKey('Tab')
    expect(outside.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)

    first.focus()
    const backwards = pressKey('Tab', true)
    expect(backwards.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(last)

    last.focus()
    const forwards = pressKey('Tab')
    expect(forwards.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
  })

  it('keeps focus in a dialog with no controls', () => {
    act(() => root.render(renderModal('Information', vi.fn())))

    const content = container.querySelector<HTMLElement>('.pdf-modal')!
    expect(document.activeElement).toBe(content)

    const tab = pressKey('Tab')
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(content)
  })

  it('routes Escape to the topmost dialog and restores focus to the underlying dialog', () => {
    const closeParent = vi.fn()
    const closeChild = vi.fn()
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          renderModal(
            'Parent',
            closeParent,
            createElement('button', { id: 'parent-action' }, 'Parent action'),
          ),
          renderModal(
            'Child',
            closeChild,
            createElement('button', { id: 'child-action' }, 'Child action'),
          ),
        ),
      ),
    )

    const parent = container.querySelector<HTMLElement>('[aria-labelledby]')!
    const childAction = container.querySelector<HTMLButtonElement>('#child-action')!
    expect(document.activeElement).toBe(childAction)
    expect(parent.hasAttribute('inert')).toBe(true)
    expect(parent.getAttribute('aria-hidden')).toBe('true')

    pressKey('Escape')
    expect(closeChild).toHaveBeenCalledOnce()
    expect(closeParent).not.toHaveBeenCalled()

    act(() =>
      root.render(
        createElement(
          'div',
          null,
          renderModal(
            'Parent',
            closeParent,
            createElement('button', { id: 'parent-action' }, 'Parent action'),
          ),
        ),
      ),
    )
    expect(document.activeElement).toBe(container.querySelector('#parent-action'))
    expect(parent.hasAttribute('inert')).toBe(false)
    expect(parent.hasAttribute('aria-hidden')).toBe(false)

    pressKey('Escape')
    expect(closeParent).toHaveBeenCalledOnce()
  })

  it('preserves mask dismissal and title-bar dragging', () => {
    const onClose = vi.fn()
    act(() => root.render(renderModal('Move me', onClose, createElement('button', null, 'Action'))))

    const mask = container.querySelector<HTMLElement>('.pdf-modal-mask')!
    act(() => mask.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onClose).toHaveBeenCalledOnce()

    const title = container.querySelector<HTMLElement>('.pdf-modal-title')!
    const modal = container.querySelector<HTMLDivElement>('.pdf-modal')!
    vi.spyOn(modal, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 100,
      width: 300,
      height: 200,
      right: 400,
      bottom: 300,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    })
    act(() => {
      title.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }),
      )
      modal.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: 50, clientY: 40 }),
      )
      modal.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 50, clientY: 40 }))
    })
    expect(modal.style.transform).toBe('translate3d(40px, 30px, 0)')
  })
})
