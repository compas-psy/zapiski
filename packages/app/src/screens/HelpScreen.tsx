/**
 * Справка: горячие клавиши и разметка Markdown.
 *
 * Заведена по прямой просьбе: «очень не хватает раздела справки, особенно по
 * горячим клавишам и по форматированию MarkDown». До этого узнать сочетание
 * было неоткуда — палитра команд (Ctrl+K) показывает часть, но её саму надо
 * сначала найти, а на телефоне клавиатуры нет вовсе.
 *
 * Почему шпаргалка по разметке нужна и в простом режиме, где символов не
 * видно (§8): файл всё равно остаётся markdown, его открывают в чужих
 * редакторах и правят там. Человек имеет право знать, во что превращается
 * то, что он набрал.
 *
 * Экран читается сверху вниз и не требует ничего нажимать — это справка, а не
 * настройки. Сочетания набраны моноширинным, потому что их сверяют посимвольно.
 */
import { type ReactNode } from 'react';
import { IconArrowLeft, IconButton } from '@zapiski/ui';

import { useApp, useLayout, useStrings } from '../state/context.js';
import { Section } from '../components/ScreenStates.js';

/**
 * `Mod` в конфигурации keymap — это Ctrl везде, кроме Apple. Показываем то,
 * что человек реально нажимает: подпись «Mod+B» ему ни о чём не говорит.
 */
function modKey(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  const platform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘' : 'Ctrl';
}

export function HelpScreen(): ReactNode {
  const app = useApp();
  const strings = useStrings();
  const layout = useLayout();
  const copy = strings.help;
  const mod = modKey();
  /* На телефоне физической клавиатуры нет — раздел сочетаний там только
     мешает. Разметка нужна на всех платформах. */
  const isMobile = layout === 'mobile' || layout === 'compact';

  return (
    <div className="za-editor">
      <div className="za-header">
        <IconButton
          icon={<IconArrowLeft size={20} />}
          label={strings.app.back}
          tone="ghost"
          onClick={() => app.back()}
        />
        <h1 className="za-h1 za-h1--mobile za-header__title">{copy.title}</h1>
      </div>

      <div className="za-scroll">
        <div className="za-page za-stack">
          {!isMobile
            ? copy.hotkeyGroups.map((group) => (
                <section key={group.title}>
                  <Section>{group.title}</Section>
                  <dl className="za-help">
                    {group.items.map(([action, keys]) => (
                      <div className="za-help__row" key={action}>
                        <dt className="za-help__what">{action}</dt>
                        <dd className="za-help__keys">{keys.replace(/Mod/g, mod)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))
            : null}

          <Section>{copy.markdownTitle}</Section>
          <p className="za-muted">{copy.markdownIntro}</p>
          <dl className="za-help">
            {copy.markdown.map(([syntax, meaning]) => (
              <div className="za-help__row" key={syntax}>
                <dt className="za-help__syntax">{syntax}</dt>
                <dd className="za-help__what">{meaning}</dd>
              </div>
            ))}
          </dl>

          <p className="za-muted">{copy.footer}</p>
        </div>
      </div>
    </div>
  );
}
