import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { EmbedApp } from './EmbedApp';
import './app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get('embed') === '1' ? <EmbedApp /> : <App />}
  </StrictMode>,
);
