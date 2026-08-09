/** Спецификация и исходники подтягиваются в тесты текстом: `?raw` — механика Vite. */
declare module '*.md?raw' {
  const content: string;
  export default content;
}
declare module '*?raw' {
  const content: string;
  export default content;
}

interface ImportMeta {
  /** Сбор файлов по маске — механика Vite, доступна и в vitest. */
  glob(
    pattern: string,
    options: { query: '?raw'; eager: true; import: 'default' },
  ): Record<string, string>;
}
