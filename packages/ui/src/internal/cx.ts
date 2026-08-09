export type ClassValue = string | false | null | undefined;

/** Мини-classnames: без зависимостей, без аллокаций сверх необходимого. */
export function cx(...values: ClassValue[]): string {
  let out = '';
  for (const value of values) {
    if (!value) continue;
    out = out ? `${out} ${value}` : value;
  }
  return out;
}
