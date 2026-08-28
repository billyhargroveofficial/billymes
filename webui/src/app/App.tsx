import { BrowserRouter } from 'react-router-dom'
import { AppProviders } from '@/app/providers/AppProviders'
import { AppRouter } from '@/app/router/AppRouter'

export default function App() {
  return (
    <AppProviders>
      <div className="grain" />
      <BrowserRouter>
        <AppRouter />
      </BrowserRouter>
    </AppProviders>
  )
}
