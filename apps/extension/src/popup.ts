import { getConsentState, isConsented, setConsent } from './consent.js'

document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('consent-toggle') as HTMLInputElement | null
  const statusMsg = document.getElementById('status-message')
  const privacyLink = document.getElementById('privacy-link') as HTMLAnchorElement | null

  async function updateUI(): Promise<void> {
    const granted = await isConsented()
    const state = await getConsentState()

    if (toggle) {
      toggle.checked = granted
    }

    if (statusMsg) {
      if (granted && state) {
        const dateStr = new Date(state.at).toLocaleDateString()
        statusMsg.textContent = `Duration telemetry is enabled (granted ${dateStr}).`
        statusMsg.className = 'status-msg enabled'
      } else {
        statusMsg.textContent = 'Duration telemetry is currently disabled.'
        statusMsg.className = 'status-msg disabled'
      }
    }
  }

  if (toggle) {
    toggle.addEventListener('change', () => {
      void setConsent(toggle.checked).then(() => {
        void updateUI()
      })
    })
  }

  if (privacyLink) {
    privacyLink.addEventListener('click', (e: MouseEvent) => {
      e.preventDefault()
      const url = privacyLink.getAttribute('href') ?? 'http://localhost:3000/settings/privacy'
      if ('tabs' in chrome) {
        void chrome.tabs.create({ url })
      } else {
        window.open(url, '_blank')
      }
    })
  }

  void updateUI()
})
