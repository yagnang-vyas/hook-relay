import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionProvider } from './api/connection';
import { App } from './App';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('root element missing');
createRoot(root).render(
  <StrictMode>
    <ConnectionProvider>
      <App />
    </ConnectionProvider>
  </StrictMode>,
);
