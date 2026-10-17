import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'
import i18n from '../i18n'

// Tests assert Uzbek text regardless of the jsdom navigator language.
await i18n.changeLanguage('uz')

// Lazy antd pages are slow to import on small machines.
configure({ asyncUtilTimeout: 5000 })

afterEach(() => cleanup())

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
