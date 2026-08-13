/* Импорты CSS — сайд-эффект для бандлера, для TypeScript значения не несут.
   Нужны ради KaTeX: свои стили редактор держит в `StyleModule`, а чужой
   пакет приходит обычным файлом стилей. */
declare module '*.css' {
  const content: string;
  export default content;
}
