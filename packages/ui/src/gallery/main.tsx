/** Точка входа витрины: `pnpm --filter @zapiski/ui gallery`. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/index.css';
import { Gallery } from './Gallery';

const host = document.getElementById('root');
if (!host) throw new Error('Не найден #root');

createRoot(host).render(
  <StrictMode>
    <Gallery />
  </StrictMode>,
);
