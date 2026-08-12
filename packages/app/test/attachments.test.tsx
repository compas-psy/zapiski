/**
 * Вложение изображения (BEHAVIOR §2.6).
 *
 * `Vault.addAttachment` был написан, покрыт тестом ядра — и не вызывался
 * НИОТКУДА. Кнопка «фото» в тулбаре имела обработчик `() => undefined`, а
 * колбэк `onPasteImage`, который редактор ждал с самого начала, экран ему не
 * передавал. То есть оба пути к вложению — кнопка и вставка из буфера — были
 * оборваны, и строка «Не удалось вставить изображение · Повторить» из реестра
 * не могла появиться в принципе.
 *
 * Здесь проверяется весь путь: файл → `attachments/` → разметка в тексте, и
 * отдельно — что до этого пути можно дотянуться из интерфейса.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { ThemeProvider, ToastProvider } from "@zapiski/ui";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../src/state/context.js";
import { AppController } from "../src/state/store.js";
import { NoteScreen } from "../src/screens/NoteScreen.js";
import { SettingsScreen } from "../src/screens/SettingsScreen.js";
import { strings } from "../src/i18n/index.js";
import { createTestHost } from "./host.js";
import { ru as editorRu } from "@zapiski/editor";

/** Нажатие кнопки панели: она слушает pointerdown, а не click. */
function press(element: Element): void {
  fireEvent.pointerDown(element);
  fireEvent.pointerUp(element);
}

const ru = strings("ru");

/** PNG размером 1×1 — настоящие байты, а не заглушка. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

const png = (name = "снимок.png"): File =>
  new File([PNG as BlobPart], name, { type: "image/png" });

async function boot(
  files: Record<string, string> = {},
): Promise<AppController> {
  const host = createTestHost({ files, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  return app;
}

describe("вложение изображения", () => {
  it("файл копируется в attachments/ и возвращает готовую разметку", async () => {
    const app = await boot();

    const result = await app.attachImage(png());

    expect(result).not.toBeNull();
    expect(result!.path).toMatch(
      /^attachments\/\d{4}-\d{2}-\d{2}_[0-9a-f]+\.png$/,
    );
    // Восклицательный знак — это картинка, а не просто файл (BEHAVIOR §2.6).
    expect(result!.markdown).toBe(`![](${result!.path})`);
    expect(await app.vaultRef!.storage.read(result!.path)).not.toBeNull();
  });

  it("одинаковые файлы не плодят копии — имя строится от хеша", async () => {
    const app = await boot();

    const first = await app.attachImage(png("раз.png"));
    const second = await app.attachImage(png("два.png"));

    expect(second!.path).toBe(first!.path);
  });

  it("расширение берётся из имени: на Android тип файла бывает пустым", async () => {
    const app = await boot();
    const noType = new File([PNG as BlobPart], "скан.jpg", { type: "" });

    const result = await app.attachImage(noType);

    expect(result!.path.endsWith(".jpg")).toBe(true);
  });

  it("сбой копирования поднимает строку реестра, а не молчит", async () => {
    const toasts: string[] = [];
    const host = createTestHost({ prefs: { onboarded: true } });
    const app = new AppController(host);
    app.setToastSink((toast) => toasts.push(toast.message));
    await app.boot();
    vi.spyOn(app.vaultRef!, "addAttachment").mockRejectedValue(
      new Error("диск"),
    );

    expect(await app.attachImage(png())).toBeNull();
    expect(toasts).toContain(ru.errors.imageInsertFailed);
  });
});

/**
 * Сторож достижимости. Тот же класс, что убил папки и меню: возможность есть,
 * а нажать нечего.
 */
describe("до вложения можно дотянуться из редактора", () => {
  async function mountNote(): Promise<void> {
    /* Тулбар — только mobile (SCREENS §4), а в jsdom окно по умолчанию
       десктопной ширины. Без этого проверялся бы экран, которого на телефоне
       нет. */
    window.innerWidth = 390;
    const host = createTestHost({
      files: { "Заметка.md": "# Заметка\n\nтекст\n" },
      prefs: { onboarded: true },
    });
    const app = new AppController(host);
    await app.boot();
    render(
      <ThemeProvider persist={false}>
        <ToastProvider>
          <AppProvider host={host} controller={app}>
            <NoteScreen path="Заметка.md" />
          </AppProvider>
        </ToastProvider>
      </ThemeProvider>,
    );
    /* Чтение заметки асинхронно: без этого экран остаётся скелетоном.
       Ждём именно поле заголовка: с ITERATION-1 §1 текстовых полей на экране
       два — название и тело, — и безымянный `textbox` стал неоднозначным. */
    await screen.findByRole("textbox", { name: "Название заметки" });
  }

  it("пункт «Изображение» открывает системный выбор файла", async () => {
    await mountNote();
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    // Галерея И камера: на Android этот accept открывает оба источника.
    expect(input!.accept).toBe("image/*");

    const opened = vi.fn();
    input!.click = opened;

    /* Вложение теперь живёт в меню панели (ITERATION-1 §4), а не отдельной
       кнопкой «фото». Кнопки панели работают по mousedown: click браузер
       обрабатывает уже после того, как фокус ушёл бы из текста. */
    press(screen.getByRole("button", { name: editorRu.panel.attachment }));
    press(await screen.findByText(editorRu.panel.attachments.image));

    expect(opened).toHaveBeenCalled();
  });

  /**
   * Решение Р4: голос — P1, микрофон из панели v1 убран совсем, а не спрятан
   * флагом. Проверяется состав панели целиком: то, что в ней объявлено §4, и
   * ничего сверх того.
   */
  it("в панели нет микрофона, а кнопки без обработчика не рисуются", async () => {
    await mountNote();
    const panel = screen.getAllByRole("toolbar")[0]!;
    const labels = Array.from(panel.querySelectorAll("button")).map((button) =>
      button.getAttribute("aria-label"),
    );
    const copy = editorRu.panel;
    expect(labels).toEqual([
      copy.undo,
      copy.redo,
      copy.blockStyle,
      copy.weight,
      copy.lists,
      copy.table,
      copy.link,
      copy.attachment,
      copy.emoji,
    ]);
    /* Формулы нет: KaTeX не подключён, а кнопка, которая есть и не работает,
       хуже отсутствующей (§4). */
    expect(labels).not.toContain(copy.formula);
  });
});

/**
 * Плашка конфликтов в настройках (SCREENS §8).
 *
 * Счётчик был литеральным нулём — `copy.conflictsMonth(0)`, — а ссылка
 * «История» имела пустой обработчик. Плашка стояла всегда и сообщала
 * заведомую неправду.
 */
describe("плашка конфликтов говорит правду", () => {
  async function mountSync(
    files: Record<string, string>,
  ): Promise<AppController> {
    window.innerWidth = 1280;
    const host = createTestHost({ files, prefs: { onboarded: true } });
    const app = new AppController(host);
    await app.boot();
    render(
      <ThemeProvider persist={false}>
        <ToastProvider>
          <AppProvider host={host} controller={app}>
            <SettingsScreen section="sync" />
          </AppProvider>
        </ToastProvider>
      </ThemeProvider>,
    );
    return app;
  }

  it("без конфликтов плашки нет вовсе", async () => {
    await mountSync({ "Заметка.md": "# Заметка\n" });
    expect(
      screen.queryByRole("button", { name: ru.settings.sync.historyLink }),
    ).toBeNull();
    expect(screen.queryByText(ru.settings.sync.conflictsMonth(0))).toBeNull();
  });

  it("копия от синка считается, и счётчик показывает её", async () => {
    // Так копию называет `SyncEngine.conflictPathFor`.
    await mountSync({
      "Заметка.md": "# Заметка\n",
      "Заметка (конфликт, устройство Samsung).md":
        "# Заметка\n\nдругая версия\n",
    });
    expect(screen.getByText(ru.settings.sync.conflictsMonth(1))).toBeTruthy();
  });

  it("«История» ведёт в историю версий конфликтной заметки", async () => {
    const app = await mountSync({
      "Заметка.md": "# Заметка\n",
      "Заметка (конфликт, устройство Samsung).md":
        "# Заметка\n\nдругая версия\n",
    });
    screen.getByRole("button", { name: ru.settings.sync.historyLink }).click();
    const route = app.getState().route;
    expect(route.name).toBe("versions");
    /*
      Проверяется НЕ ТОЛЬКО имя маршрута, но и то, что в него передано.
      Прежняя редакция теста обрывалась на имени — и пропустила, что ссылка
      отдавала `.id` заметки, тогда как `VersionsScreen` объявляет
      `noteId: VaultPath` и зовёт `vault.read(noteId)`. Экран открывался
      пустым: заметки по такому «пути» на диске нет.
    */
    expect(route.name === "versions" && route.noteId).toBe(
      "Заметка (конфликт, устройство Samsung).md",
    );
  });
});
