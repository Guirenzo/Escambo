import { useEffect, useState } from 'react';
import { api } from './lib/api';
import { LoginForm } from './features/auth/LoginForm';
import './styles.css';

export function App() {
  const [health, setHealth] = useState('verificando…');
  const [online, setOnline] = useState(false);

  useEffect(() => {
    api
      .health()
      .then((h) => {
        setHealth(`${h.status} · db ${h.db}`);
        setOnline(h.status === 'ok');
      })
      .catch(() => {
        setHealth('offline');
        setOnline(false);
      });
  }, []);

  return (
    <main className="container">
      <header className="hero">
        <h1>Escambo</h1>
        <p className="tagline">O iFood dos serviços</p>
        <span className={`status ${online ? 'up' : 'down'}`}>API: {health}</span>
      </header>
      <LoginForm />
      <footer className="foot">
        Front (React + Vite + TS) → API (Node + Express + TS) → MySQL 8 · tipos compartilhados via{' '}
        <code>@escambo/types</code>
      </footer>
    </main>
  );
}
