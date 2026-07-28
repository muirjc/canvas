import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Order matters: tokens define the custom properties everything else consumes, and base.css
// styles bare elements (which is what restyles the admin screens without editing them).
import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/components.css';
import '../styles/layout.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
