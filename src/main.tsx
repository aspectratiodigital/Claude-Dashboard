import { createRoot } from 'react-dom/client'
import App from './App'
import { startData } from './data/store'

startData()
createRoot(document.getElementById('root')!).render(<App />)
