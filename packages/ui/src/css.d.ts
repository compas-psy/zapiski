/* Импорты CSS — сайд-эффект для бандлера, для TypeScript значения не несут. */
declare module '*.css' {
  const content: string;
  export default content;
}

/* Импорт .svg отдаёт URL ассета (Vite). Знак сервиса подключается именно так —
   файл дизайн-системы обязан попадать в сборку неизменным (DS-ALIGNMENT §9). */
declare module '*.svg' {
  const url: string;
  export default url;
}
