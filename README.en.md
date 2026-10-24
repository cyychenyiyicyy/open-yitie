# Open作业贴 (Open Homework Board)

> A homework board for the classroom big screen — **open-source, fully offline**
> Runs entirely offline. Data never leaves the machine. No accounts, no network.

**Author: yiyi　|　License: [MIT](LICENSE)　|　[中文文档](README.md)**

---

## What it is

Open作业贴 (Open Homework Board) is a homework display for the **classroom projector/screen**:

- Teachers see every subject's homework for the day at a glance — no flipping through a notebook
- Nine subjects built in (Chinese / Math / English / Physics / Chemistry / Biology / Politics / History / Geography)
- Bundled textbook chapter index — pick "同步学与练 P20" or "导学案 Chapter 3" instead of typing page numbers
- Due-date highlighting (today / tomorrow / which weekday) so urgent work stands out
- Quick note clauses ("don't write #3, #5", "only the first three questions", "due tomorrow")
- **Floating window mode**: pin the homework as a small always-on-top window so you can show other material and still read the homework
- Weekly overview: see how much homework each day and each subject adds up to
- Dark / light themes, scalable full-screen type, presentation mode

## Why "offline"

This edition **removes every network-dependent feature** and keeps only what actually matters in a classroom:

| Removed | Details |
|---|---|
| **Cloud sync** | No longer pushes/pulls to Gitee or GitHub, no tokens stored, no network needed |
| **Auto-update** | The app never checks for updates; get new versions manually from the GitHub repo |
| **Voice input** | Microphone buttons, recording, audio capture — all gone |
| **AI** | The "AI Add" dialog, model configuration, API calls, key management — all gone |
| **Third-party APIs** | The built artifact contains **no** `fetch`, `XMLHttpRequest`, or `WebSocket` |

**Where does the data live?** On that one machine only. Two cases:

- Installed as the Electron app → `~/.config/open-yitie/data/data.json` (Linux)
- Opened directly in a browser → the browser's localStorage

Before switching computers or reinstalling, use **Data → Export all homework** to save a JSON backup.

## Install

### Option 1: Single file (simplest)

Download [`open-yitie.html`](open-yitie.html) and open it in a browser — that's the entire
application, one file, nothing to install, works with the network unplugged.

### Option 2: Desktop app (Linux)

```bash
git clone https://github.com/cyychenyiyicyy/open-yitie.git
cd open-yitie/electron
npm install
npm start
```

Build a `.deb` package (Linux x64):

```bash
cd electron
npx electron-builder --linux deb
# artifact lands in electron/out/
```

## Build from source

```bash
git clone https://github.com/cyychenyiyicyy/open-yitie.git
cd open-yitie
node build.cjs          # → open-yitie.html (single-file app)
```

`build.cjs` merges `src/template.html` + `src/app.js` + `data/books-*.json` into a single
file and runs 20 self-checks — including the **offline checks**: the artifact must not contain
`fetch`, cloud-sync functions, AI functions, or voice functions.

## Repository layout

```
open-yitie/
├── open-yitie.html        ← build artifact: the whole app (open it in a browser)
├── build.cjs              ← build script (node build.cjs)
├── src/
│   ├── template.html      ← page skeleton + all CSS
│   ├── app.js             ← all interaction logic
│   ├── bg-art.js          ← card background art (built-in patterns)
│   ├── bg-photos.js       ← card background art (photos)
│   └── bg-photos.json     ← background image data
├── data/
│   └── books-*.json       ← chapter index for the nine subjects
├── electron/              ← desktop shell (Electron)
│   ├── main.js            ← main process: window, tray, data dir, (optional) updates
│   ├── preload.js         ← bridge between page and local file storage
│   ├── mini.js / mini.html← floating window mode
│   ├── store.js           ← reads/writes data.json
│   ├── assets/            ← app and tray icons
│   └── package.json
├── tools/
│   ├── strip-online-features.cjs  ← removes cloud sync / AI / voice from app.js
│   ├── strip-template.cjs         ← removes the matching CSS and DOM
│   ├── rename-branding.cjs        │ renames + sets the copyright line
│   ├── adapt-verify-wizard.cjs   ← adapts the acceptance harness for offline
│   ├── static-check.cjs           ← delivery-shape static checks (incl. offline)
│   └── verify-wizard.cjs          ← end-to-end acceptance harness (274 assertions)
├── LICENSE                ← MIT
└── NOTICE                 ← copyright and credits
```

## Developing

After editing anything under `src/`, **always rebuild**:

```bash
node build.cjs
node tools/static-check.cjs     # delivery-shape checks (single file, no external links, no debug leftovers)
```

### Want to bring a feature back?

This repo makes "removing the network features" **a replayable script** rather than a
hand edit:

```bash
# Starting from a source tree that still has the network features:
node tools/strip-online-features.cjs   # strips cloud sync + AI + voice
node tools/strip-template.cjs          # strips the matching CSS and DOM
node tools/rename-branding.cjs         # renames + sets the copyright line
```

To restore a feature, look up the matching `cut(...)` block in
`tools/strip-online-features.cjs`, comment it out, and put the implementation back.

## Requirements

- Browser: Chromium 93+ (verified on UOS 20 / domestic Chinese Linux builds)
- Desktop: Node.js 18+, Electron 28+
- The page deliberately sticks to ES5 syntax (`var` + `function`) and avoids optional chaining,
  nullish coalescing, `color-mix()`, `:has()`, and `oklch()` — so nothing silently fails on old engines

## Known limitations

- Floating window mode requires the desktop app; browsers cannot create always-on-top windows
- Data does not sync across devices — that is the trade-off of the offline edition.
  Use "Export all homework" for backups.

## Credits

- Interface implemented following the [Material Design 3](https://m3.material.io/) specification
- Chapter index data curated by this project

## License

[MIT](LICENSE)　© 2026 yiyi
