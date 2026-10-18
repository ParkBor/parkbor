import '@ant-design/v5-patch-for-react-19'
import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { Modal, message } from 'antd'
import { afterEach } from 'vitest'
import i18n from '../i18n'

// Tests assert Uzbek text regardless of the jsdom navigator language.
await i18n.changeLanguage('uz')

// Lazy antd pages are slow to import on small machines.
configure({ asyncUtilTimeout: 5000 })

afterEach(() => {
  cleanup()
  // Static dialogs / toasts live outside the React tree and would leak into the next test.
  Modal.destroyAll()
  message.destroy()
  document.body.querySelectorAll('.ant-modal-root, .ant-modal-mask').forEach((node) => node.remove())
})

// jsdom lacks these browser APIs that Ant Design relies on.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }),
})

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
