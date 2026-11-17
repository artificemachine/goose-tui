# process — newline-key-ux (хронология фактов и проверок)

Все пути — относительно `/home/viorn/sources/cgoose`. Время: 2026-11-13.

## 1. Где обрабатывается перевод строки

- `rg -n "newline|ctrl\+j" src/acp/*.ts` → в rossii **ничего**: composer — это `Editor` из
  `@earendil-works/pi-tui` (`src/acp/chat-ui.ts:80`, `new Editor(tui, editorTheme, …)`);
  `src/acp/chat-ui.ts` и `src/acp/chat-io.ts` манипулируют только `\r`-независимыми вещами
  (`editor.onSubmit`, `submitPrompt`, steering).
- Вывод: поведение целиком библиотечное, rossii его не переопределяет.

## 2. Что библиотека считает новой строкой

`node_modules/@earendil-works/pi-tui/dist/components/editor.js:719–735` — ветка «New line»:

```js
if (kb.matches(data, "tui.input.newLine") ||
    (data.charCodeAt(0) === 10 && data.length > 1) ||
    data === "\x1b\r" ||
    data === "\x1b[13;2~" ||
    (data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
    (data === "\n" && data.length === 1)) { … this.addNewLine(); }
```

`dist/keybindings.js:74–75`:

```js
"tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j"], … }
"tui.input.submit":  { defaultKeys: "enter", … }
```

`dist/keys.js:757–800` (матчинг `enter`): `shift+enter` = `CSI 13;2u` / `CSI 27;2;13~`, а
`\x1b\r` / `\n` — **только когда `_kittyProtocolActive === true`**; `enter` = `\r` (и `\n`, если
протокол не активен).

## 3. Как включается протокол

`dist/terminal.js:140–260` — при старте шлёт `CSI > 7 u` + `CSI ? u`, ждёт ответ; при `DA`-ответе
без Kitty включает fallback `modifyOtherKeys` (`CSI > 4 ; 2 m`, `terminal.js:309–312`).
Таймаут склейки ответа `KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150` мс.
Только для Apple Terminal и win32 есть «нативный» трюк: опрос физически зажатого Shift
(`isNativeModifierPressed`) и превращение `\r` → `CSI 13;2u` (`terminal.js:44–57`). На Linux
такого пути нет.

## 4. Эмпирическая проверка (скрипт `/tmp/newline-probe.ts`)

Живой `Editor` с фейковым TUI, `setKittyProtocolActive(false|true)`, текст `"ab"`, на вход одна
последовательность, смотрим `getText()` / сработал ли `onSubmit`:

| последовательность | `\r` | `\n` | `CSI 13;2u` | `CSI 27;2;13~` | `CSI 13;2~` | `ESC CR` | `CSI 13;3u` (alt) | `CSI 13;5u` (ctrl) |
|---|---|---|---|---|---|---|---|---|
| без протокола | **submit** | newline | newline | newline | newline | newline | IGNORED | IGNORED |
| Kitty active  | **submit** | newline | newline | newline | newline | newline | IGNORED | IGNORED |

(Полный вывод — `bun /tmp/newline-probe.ts`; скрипт одноразовый, в репозиторий не добавлялся.)

Выводы:
- `Ctrl+J` (`\n`) — новая строка в **любом** режиме: это отдельный байт, а не модификатор.
- `Shift+Enter` работает **только если терминал прислал протокольную последовательность**; в
  legacy он приходит как `\r` и попадает в `submit`.
- `Alt+Enter` (`ESC CR`) работает в legacy (жёстко захардкожен в ветке newLine), но под Kitty
  приходит как `CSI 13;3u` и **игнорируется** — «Alt+Enter везде» неверно, вопреки README
  библиотеки («Alt+Enter most reliable», `node_modules/@earendil-works/pi-tui/README.md:475`).
- `Ctrl+Enter` не поддержан вообще (ни `CSI 13;5u`, ни legacy-эквивалента нет).
- `\` + Enter — встроенный обходной путь для терминалов без Shift+Enter (`editor.js:740–748`,
  `shouldSubmitOnBackslashEnter`).

## 5. Настраиваемость без форка

`dist/keybindings.js:149–230`: `KeybindingsManager(definitions, userBindings)` +
`setKeybindings(manager)` — глобальный реестр, `matches()` читает его на каждом нажатии.
То есть `tui.input.newLine` можно переопределить из rossii (до создания `Editor`).
API `tui.terminal.kittyProtocolActive` / `.modifyOtherKeysActive` публично (`dist/terminal.js:117`,
`dist/tui.d.ts:226,261`) → подсказку можно печатать по факту, а не наугад.

## 6. Что не удалось проверить

- Что именно шлёт терминал VS Code (`CSI 13;2u`, `CSI 27;2;13~` или `ESC CR`) — VS Code desktop
  локально не установлен (только `~/.vscodium-server`), сеть недоступна
  (`uvx ddgs …` → `Network is unreachable`). Для вывода это неважно: `Editor` принимает все три
  как новую строку (см. §4), поэтому «в VS Code Shift+Enter работает» объясняется любой из них.
- Поведение реальных терминалов (GNOME Terminal/VTE, Konsole, Alacritty, kitty) — по документации,
  не проверено запуском.

## 7. Детали `\` + Enter (уточнение, 15:23)

`editor.js:1133–1144` (`shouldSubmitOnBackslashEnter`) и `editor.js:738–751` (ветка submit):
новая строка вместо отправки, если перед курсором `\`. Условия:

- `disableSubmit === false` (в rossii не выставляется);
- `matchesKey(data, "enter")` — т.е. **только обычный Enter**; настоящая Shift+Enter-последовательность
  (`CSI 13;2u`) сюда не попадает, а идёт в обычную ветку newLine;
- для пути из ветки newLine (`1133`) дополнительно требуется, чтобы `tui.input.submit` содержал
  `shift+enter`/`shift+return` — при переопределении bindings через `setKeybindings` этот путь
  перестаёт работать (актуально для D3);
- `\` удаляется (`handleBackspace`), остатка в тексте нет.

Следствия: комбинация работает одинаково в legacy и под Kitty (в отличие от `Alt+Enter`), стоит двух
нажатий и «съедает» настоящий обратный слэш в конце строки (путь вида `C:\` + Enter).

## 8. Реализация (15:26)

Правки:

- `src/acp/chat-ui.ts:136–140` — в стартовую подсказку добавлено
  `· Enter sends; Ctrl+J adds a line (Shift+Enter where the terminal reports it, \ then Enter anywhere)`
  между блоком `Ctrl+…` и клаузой steering (в JS-строке слэш экранирован: `"\\ then Enter"`).
- `README.md:230–245` — в таблицу шорткатов добавлена строка `Ctrl+J` (заголовок колонки стал
  `Key | Does`, потому что перевод строки — не «что открывает») и абзац «почему»: CR/LF, CSI-u и
  `modifyOtherKeys`, встроенный `\` + Enter, `Ctrl+E` как последний вариант.
- `README.ru.md:224–239` — то же на русском.

Проверки:

- `bun run check` (`tsc -p tsconfig.json`) — чисто.
- `bun run test` — `exit=0`, 20 наборов, ни одного падения (единственное совпадение по слову
  `failed` — имя теста «failed status bar shows ❌»).
- Рендер подсказки проверен отдельным скриптом (`/tmp/hint-probe.ts`, `Text.render(80|120)`):
  строка переносится корректно, `\` отображается, обрезки нет. Скриншот-прогон чата не делался —
  для статичной строки он ничего не добавляет.
