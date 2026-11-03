/** First-input IME composition in the shared Web and Desktop composer. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

it('retains the first composition on a fresh composer and after clearing it', async () => {
  const scaffold = await launchWebScaffold({})
  try {
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-composition'))
      const tripwire = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl)
      await connectFreshWorkspace(page, scaffold.workspaceCwd, 'composer-composition')
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      const placeholder = page.locator('[data-composer-placeholder]').first()
      const cdp = await page.context().newCDPSession(page)
      const observations: string[] = []
      try {
        for (const state of ['Fresh composer', 'Cleared composer']) {
          await page.locator('[data-composer-card]').first().click({ position: { x: 8, y: 8 } })
          await expect.poll(() => input.evaluate((element) => {
            const selection = element.ownerDocument.getSelection()
            return element.ownerDocument.activeElement === element && selection !== null && element.contains(selection.anchorNode)
          })).toBe(true)
          await expect.poll(() => input.textContent()).toBe('')
          await cdp.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
          // Lexical may retain its zero-width composition anchor until commit.
          await expect.poll(() => input.textContent()).toMatch(/^n\u200b?$/u)
          expect(await placeholder.isVisible()).toBe(false)
          await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
          await expect.poll(() => input.textContent()).toMatch(/^ni\u200b?$/u)
          await cdp.send('Input.insertText', { text: '你' })
          await expect.poll(() => input.textContent()).toBe('你')
          await expect.poll(() => input.getAttribute('data-composer-composing')).toBe(null)
          observations.push(`- ${state}: first preedit n → ni → committed 你; placeholder hidden`)
          await page.keyboard.press('ControlOrMeta+KeyA')
          await page.keyboard.press('Backspace')
          await expect.poll(() => input.textContent()).toBe('')
          await expect.poll(() => placeholder.isVisible()).toBe(true)
        }
      } finally {
        await cdp.detach()
      }
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
      await compareOrRefreshGolden(
        fileURLToPath(new URL('./expected/composer-composition/first-input.expected.md', import.meta.url)),
        observations.join('\n'), webSnapshotMode(),
      )
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
