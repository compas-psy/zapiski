/**
 * Контекстная полоса «Рассказать, что пошло не так?».
 *
 * ── Почему полоса, а не модалка и не тост ───────────────────────────────────
 *
 * Модалка перехватывает управление — предлагать что-то человеку, у которого
 * только что не получилось, перегородив ему дорогу, значит наказать его за наш
 * же сбой. Тост исчезает через несколько секунд: пока человек осознаёт, что
 * произошло, предложение уже уехало, и нажать по нему нельзя.
 *
 * Полоса стоит там, где её видно, ничего не перекрывает и ждёт столько,
 * сколько нужно. Уходит она по одному из трёх событий: согласились, закрыли,
 * ушли с экрана.
 *
 * ── Почему «Не сейчас», а не крестик ────────────────────────────────────────
 *
 * Крестик читается как «убрать с глаз», и по нему нажимают не глядя. Здесь у
 * отказа есть цена — неделя тишины, — и человек имеет право понимать, что он
 * отвечает, а не отмахивается. Подпись словами делает выбор осознанным.
 *
 * Текст полосы зависит от повода: «что-то пошло не так» после конфликта
 * заметок было бы неправдой — там ничего не сломалось, там разошлось.
 */
import { type ReactNode } from 'react';
import { Button, IconClose, IconButton } from '@zapiski/ui';

import { useApp, useAppState, useStrings } from '../state/context.js';

export function FeedbackPrompt(): ReactNode {
  const app = useApp();
  const state = useAppState();
  const strings = useStrings();
  const prompt = state.feedbackPrompt;
  if (prompt === null) return null;

  const copy = strings.feedback.prompt;
  const message = copy[prompt.entry];

  return (
    <div className="za-feedback-bar" role="status">
      <span className="za-feedback-bar__text">{message}</span>
      <Button
        variant="text"
        size="compact"
        onClick={() => app.openFeedback(prompt.entry, prompt.context)}
      >
        {copy.action}
      </Button>
      <IconButton
        icon={<IconClose size={16} />}
        label={copy.dismiss}
        tone="ghost"
        onClick={() => void app.dismissFeedbackPrompt()}
      />
    </div>
  );
}
