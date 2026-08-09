/**
 * PWA-часть оболочки: регистрация service worker'а и цвет системного хрома.
 *
 * Кнопки «Установить» здесь нет намеренно. Установку предлагает сам браузер,
 * как только выполнены критерии (манифест + service worker + HTTPS), а рисовать
 * свою кнопку в `apps/web` запрещено: это был бы элемент интерфейса, которого
 * нет на Android и Windows (ARCHITECTURE §1). Поэтому `beforeinstallprompt`
 * мы не перехватываем — родной интерфейс установки остаётся на месте.
 */

/** Регистрация SW. Ошибка регистрации не должна ломать работу приложения. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  if (!window.isSecureContext) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  });
}

/**
 * `theme-color` берётся из токена `--bg` текущей темы — литерала цвета в
 * исходниках нет (ARCHITECTURE §3.4). Обновляется при смене темы: атрибут
 * `data-theme` на `<html>` меняет ThemeProvider, мы за ним наблюдаем.
 */
export function syncThemeColor(): () => void {
  const root = document.documentElement;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }

  const apply = (): void => {
    const value = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (value !== '') meta.content = value;
  };

  apply();
  const observer = new MutationObserver(apply);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] });
  return () => observer.disconnect();
}
