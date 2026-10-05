/** Tabela de níveis (RN-052). Fica à parte porque o repository grava o nível do total travado. */
export const LEVELS = [
  { level: 1, name: 'Iniciante', min: 0 },
  { level: 2, name: 'Aprendiz', min: 300 },
  { level: 3, name: 'Profissional', min: 800 },
  { level: 4, name: 'Especialista', min: 2000 },
  { level: 5, name: 'Mestre', min: 5000 },
  { level: 6, name: 'Lenda', min: 12000 },
] as const;

export function levelFor(totalXp: number): { level: number; name: string; min: number } {
  let current: (typeof LEVELS)[number] = LEVELS[0];
  for (const l of LEVELS) {
    if (totalXp >= l.min) current = l;
  }
  return { level: current.level, name: current.name, min: current.min };
}
