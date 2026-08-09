/* Импорты CSS — сайд-эффект для бандлера, для TypeScript значения не несут. */
declare module '*.css' {
  const content: string;
  export default content;
}

/* Объявления `*.svg` здесь намеренно нет: знак сервиса подключается через
   `new URL('…', import.meta.url)` (см. components/ServiceMark), чтобы не
   заставлять каждый пакет-потребитель повторять ambient-объявление. */
