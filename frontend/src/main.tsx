import React from 'react'
import ReactDOM from 'react-dom/client'
import 'katex/dist/katex.min.css'
import App from './app/App'
import './index.css'
// 主题层（P6）：只在 <html> 带主题属性时覆盖 token 取值，必须排在 index.css 之后。
import './theme/theme.css'
import './i18n'
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
