import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Desmonta a árvore React entre os testes (evita vazamento de DOM).
afterEach(() => cleanup());
