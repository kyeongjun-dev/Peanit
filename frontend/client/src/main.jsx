import React from 'react' // ✨ 이 줄이 빠져서 에러가 난 것입니다. 꼭 추가해주세요!
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)