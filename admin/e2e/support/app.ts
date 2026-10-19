// Shared Playwright fixtures: the mock API, the Telegram widget stub and navigation helpers.
//
// Tokens live in memory only, so a full page load (page.goto) ends the session. After sign-in the
// tests move with the menu or with goTo(), which uses the History API and never reloads.
import { expect, test as base, type Page } from '@playwright/test'
import { MockApi } from './mockApi'
import { t } from './i18n'

const WIDGET_URL = 'https://telegram.org/js/telegram-widget.js*'

// Stand-in for telegram-widget.js. Like the real script it renders its own control next to the
// <script> tag and, on click, evaluates the data-onauth attribute with a `user` object in scope.
const WIDGET_STUB = `
(function () {
  var script = document.currentScript;
  if (!script || !script.parentNode) return;
  var button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Mock Telegram login';
  button.setAttribute('data-testid', 'mock-telegram-login');
  button.addEventListener('click', function () {
    var user = { id: 777001, first_name: 'E2E', auth_date: Math.floor(Date.now() / 1000), hash: 'e2e-widget-hash' };
    eval(script.getAttribute('data-onauth'));
  });
  script.parentNode.appendChild(button);
})();
`

interface Fixtures {
  api: MockApi
}

export const test = base.extend<Fixtures>({
  api: async ({ page }, use) => {
    const api = new MockApi()
    await api.install(page)
    await page.route(WIDGET_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'application/javascript', body: WIDGET_STUB }),
    )
    await use(api)
  },
})

export { expect }

/** Open the login screen and press the (stubbed) Telegram button; resolves when the menu shows. */
export async function signIn(page: Page, api: MockApi, role: MockApi['role'] = 'ADMIN'): Promise<void> {
  api.role = role
  await page.goto('/login')
  await page.getByTestId('mock-telegram-login').click()
  await expect(page.getByRole('menu')).toBeVisible()
}

/** Client-side navigation: keeps the in-memory session (a page load would drop it). */
export async function goTo(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[/]/g, '\\/')}$`))
}

export async function openMenu(page: Page, labelKey: string): Promise<void> {
  await page.getByRole('menuitem', { name: t(labelKey), exact: true }).click()
}

/** Menu entries as text, in order. */
export async function menuLabels(page: Page): Promise<string[]> {
  return page.getByRole('menuitem').allInnerTexts()
}

/** Every place the browser keeps state for the origin, as one searchable string. */
export async function storageDump(page: Page): Promise<string> {
  const web = await page.evaluate(() =>
    JSON.stringify({
      local: { ...window.localStorage },
      session: { ...window.sessionStorage },
      cookie: document.cookie,
      url: window.location.href,
    }),
  )
  const cookies = JSON.stringify(await page.context().cookies())
  return `${web}${cookies}`
}

/** Open an antd Select by its accessible name (the inner input is covered by the label span). */
export async function openSelect(page: Page, name: string): Promise<void> {
  await page.locator('.ant-select', { has: page.getByRole('combobox', { name, exact: true }) }).click()
}

/** An antd Select picked by its accessible name, then an option by its visible text. */
export async function pickOption(page: Page, selectName: string, optionText: string): Promise<void> {
  await openSelect(page, selectName)
  // The role=option nodes are an invisible accessibility copy; click the rendered item.
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')
    .getByText(optionText, { exact: true })
    .click()
}
