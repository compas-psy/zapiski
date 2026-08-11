/**
 * Версия сборки, подставленная vite (`define` в vite.config.ts). Не
 * `import.meta.env`: та часть окружения читается из .env и может отсутствовать,
 * а версия обязана быть в бандле всегда — её называют в письме поддержке.
 */
declare const __ZAPISKI_VERSION__: string;
