/**
 * Web application entry: thin bootstrap over the shell library. Everything —
 * The auth entry stays intentionally small: the main application shell is
 * loaded only after the browser has completed its signed authentication flow.
 */
import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { AuthenticationGate } from '@deepseek-ai/dsh-client-web/auth'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
const root = createRoot(el)
root.render(createElement(AuthenticationGate, {
  onAuthenticated: (renewal) => {
    root.unmount()
    void import('@deepseek-ai/dsh-client-web').then(({ AppWebEntry }) => {
      void new AppWebEntry(el, undefined, renewal).run()
    })
  },
}))
