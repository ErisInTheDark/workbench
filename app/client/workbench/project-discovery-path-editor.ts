/*
 * Exports:
 * - ProjectDiscoveryPathRow: stable identity and text for one draft row.
 * - createProjectDiscoveryRows: initialise ordered paths with one trailing blank.
 * - editProjectDiscoveryRow: keep one trailing blank as the last row fills.
 * - removeProjectDiscoveryRow: delete one row while retaining an editable trailing blank.
 * - blurProjectDiscoveryRow: remove empty non-final rows.
 * - populatedProjectDiscoveryRows: pair persisted values with stable row identities.
 */
export interface ProjectDiscoveryPathRow {
  id: number;
  value: string;
}

export function createProjectDiscoveryRows(paths: readonly string[]): ProjectDiscoveryPathRow[] {
  return [...paths.filter(path => path.trim()).map((value, id) => ({ id, value })), { id: paths.length, value: "" }];
}

export function editProjectDiscoveryRow(rows: readonly ProjectDiscoveryPathRow[], id: number, value: string): ProjectDiscoveryPathRow[] {
  const next = rows.map(row => row.id === id ? { ...row, value } : row);
  if (next.every(row => row.value.trim())) {
    next.push({ id: Math.max(-1, ...next.map(row => row.id)) + 1, value: "" });
  }
  return next;
}

export function removeProjectDiscoveryRow(rows: readonly ProjectDiscoveryPathRow[], id: number): ProjectDiscoveryPathRow[] {
  const remaining = rows.filter(row => row.id !== id);
  return remaining.some(row => !row.value.trim())
    ? remaining
    : [...remaining, { id: Math.max(-1, ...rows.map(row => row.id)) + 1, value: "" }];
}

export function blurProjectDiscoveryRow(rows: readonly ProjectDiscoveryPathRow[]): ProjectDiscoveryPathRow[] {
  const filled = rows.filter(row => row.value.trim());
  const lastBlank = rows.findLast(row => !row.value.trim());
  return [...filled, lastBlank ?? { id: Math.max(-1, ...rows.map(row => row.id)) + 1, value: "" }];
}

export function populatedProjectDiscoveryRows(rows: readonly ProjectDiscoveryPathRow[]) {
  return rows.filter(row => row.value.trim()).map(row => ({ id: row.id, value: row.value.trim() }));
}
