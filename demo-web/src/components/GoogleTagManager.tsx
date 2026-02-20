// components/GoogleTagManager.tsx

import { useEffect } from 'react'
import { GTM_ID, pageview } from '../config/gtm'

const GoogleTagManager = () => {
  useEffect(() => {
    const script = document.createElement('script')
    script.async = true
    script.src = `https://www.googletagmanager.com/gtm.js?id=${GTM_ID}`
    document.head.appendChild(script)

    window.dataLayer = window.dataLayer || []
    window.dataLayer.push({
      'gtm.start': new Date().getTime(),
      event: 'gtm.js'
    })

    pageview(window.location.pathname)

    return () => {
      document.head.removeChild(script)
    }
  }, [])

  return (
    <noscript>
      <iframe
        src={`https://www.googletagmanager.com/ns.html?id=${GTM_ID}`}
        height="0"
        width="0"
        style={{ display: 'none', visibility: 'hidden' }}
      />
    </noscript>
  )
}

export default GoogleTagManager
