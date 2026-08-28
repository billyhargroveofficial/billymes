// Safari samples chrome colors at FIRST paint only, so set the theme before
// styles or React boot. This stays external to keep the production CSP strict.
try {
  const storedMode = localStorage.getItem('mes.theme-mode')
  const bootTheme =
    storedMode === 'light' || storedMode === 'dark'
      ? storedMode
      : matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
  document.documentElement.dataset.theme = bootTheme
  document.documentElement.style.colorScheme = bootTheme
} catch {
  // The document's existing theme remains the safe fallback.
}
