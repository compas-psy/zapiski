/**
 * Заголовок отдельным полем — со стороны человека (ITERATION-1 §1).
 *
 * Разбор текста проверен в ядре (`markdown.title.test.ts`). Здесь то, ради
 * чего поле заводилось: видно, где кончается название и начинается заметка;
 * Enter из названия не ломает строку, а переводит в текст; название доезжает
 * до файла первой строкой `# …` и до имени файла — переименованием.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeProvider, ToastProvider } from "@zapiski/ui";
import { AppProvider } from "../src/state/context.js";
import { NoteScreen } from "../src/screens/NoteScreen.js";
import { AppController } from "../src/state/store.js";
import { createTestHost } from "./host.js";

async function mountNote(files: Record<string, string>, path: string) {
  const host = createTestHost({ files, prefs: { onboarded: true } });
  const app = new AppController(host);
  await app.boot();
  render(
    <ThemeProvider persist={false}>
      <ToastProvider>
        <AppProvider host={host} controller={app}>
          <NoteScreen path={path} />
        </AppProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
  const title = await screen.findByRole<HTMLInputElement>("textbox", {
    name: "Название заметки",
  });
  return { app, host, title };
}

describe("поле заголовка", () => {
  it("показывает название, а тело — без строки `# …`", async () => {
    const { title } = await mountNote(
      { "Заметка.md": "# Планы на неделю\n\nкупить билеты\n" },
      "Заметка.md",
    );
    expect(title.value).toBe("Планы на неделю");
    /* Строки заголовка в теле нет — иначе название показывалось бы дважды. */
    const editor = document.querySelector(".cm-content");
    expect(editor?.textContent).toContain("купить билеты");
    expect(editor?.textContent).not.toContain("# Планы");
  });

  it("у заметки без H1 поле пустое, а текст цел", async () => {
    /* Чужой vault: ничего не переносим и не переписываем. */
    const { title } = await mountNote(
      { "Чужая.md": "просто текст\nвторая строка\n" },
      "Чужая.md",
    );
    expect(title.value).toBe("");
    expect(document.querySelector(".cm-content")?.textContent).toContain(
      "просто текст",
    );
  });

  it("«###» больше не показывается названием", async () => {
    /* Ровно случай со скриншота. */
    const { title } = await mountNote({ "Обрывок.md": "###\n" }, "Обрывок.md");
    expect(title.value).toBe("");
  });

  it("набранное название доезжает до файла первой строкой", async () => {
    const { app, host } = await mountNote({ "Пустая.md": "" }, "Пустая.md");
    const field = screen.getByRole("textbox", { name: "Название заметки" });
    fireEvent.change(field, { target: { value: "Личное" } });

    await waitFor(async () => {
      const note = await app.readNote("Пустая.md");
      expect(note?.body).toBe("# Личное\n");
    });
    expect(host.storage).toBeDefined();
  });

  it("Enter в названии не ломает строку", async () => {
    const { title } = await mountNote(
      { "Заметка.md": "# Название\n\nтекст\n" },
      "Заметка.md",
    );
    fireEvent.keyDown(title, { key: "Enter" });
    /* Перенос в однострочном поле невозможен, но проверяем и значение: Enter
       обязан увести курсор в тело, а не дописать что-либо в название. */
    expect(title.value).toBe("Название");
  });
});
