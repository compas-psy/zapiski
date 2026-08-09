/** Спецификация подтягивается в тест текстом: `?raw` — механика Vite. */
declare module '*.md?raw' {
  const content: string;
  export default content;
}
