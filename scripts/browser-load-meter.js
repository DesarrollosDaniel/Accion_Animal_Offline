// Used only in a temporary diagnostic HTML page; records timings without response bodies or credentials.
const requests = []
const originalFetch = window.fetch.bind(window)
window.fetch = async (...args) => {
  const path = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname
  const start = performance.now()
  const response = await originalFetch(...args)
  if (path.startsWith('/api/')) requests.push({ path, status: response.status, headersMs: +(performance.now() - start).toFixed(2) })
  return response
}
const observer = new MutationObserver(() => {
  if (!document.querySelector('.sidebar-profile') || !requests.some((request) => request.path === '/api/local/summary')) return
  observer.disconnect()
  const output = document.createElement('pre')
  output.dataset.testid = 'load-measurement'
  output.style.cssText = 'position:fixed;bottom:0;right:0;z-index:9999;background:white;color:black;padding:12px;font:12px monospace;max-height:35vh;overflow:auto;border:1px solid #176b4d'
  output.textContent = JSON.stringify({ panelReadyMs: +performance.now().toFixed(2), requests }, null, 2)
  document.body.append(output)
})
observer.observe(document.documentElement, { childList: true, subtree: true })
