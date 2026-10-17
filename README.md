# hana local

A task manager you can paste anything into, that runs entirely on your own
device. Drop in a full email, meeting notes, or a single line like "call the
vet Friday," press Extract tasks, and a small open source model running in your
browser pulls out the real tasks for you to review before anything is added.

**Use it:** https://olagon.github.io/hana-local/

No server. No account. No analytics. No tracking. Your words never leave this
device. Everything the page loads comes from this same site, the fonts, the
interface, and the WebLLM engine under `vendor/`. The one outside request is
the one-time download of a model's weights when you pick one, and even that
disappears if you bundle a model into the site (see below). Turn on airplane
mode after the download and it keeps working.

## What it does

- **Paste anything.** The model labels every line it finds, then hana keeps
  only real tasks that are yours. Things other people said they would do,
  newsletters, and plain info land in a Skipped list you can rescue from with
  one tap.
- **Dates it gets right.** Phrases like "by Thursday," "week of the 20th," or
  "in two weeks" are worked out by hana's own date resolver, not guessed by the
  model, so they land on the right day and nothing gets an invented date.
- **Review before anything is added.** Edit title, date, and project in place,
  flip items between Active and the Holding Tank, uncheck what you don't want.
  Unsure items start unchecked. Enter accepts everything.
- **Active and the Holding Tank.** Now-or-soon work in one list, someday and
  waiting-on items in the other. Dates never move on their own; overdue items
  gather under Late at the top.
- **Add as is.** Skip the model entirely, one task per line, instant. Also the
  escape hatch if a read is slow, next to a Stop button.
- **Voice.** Opt-in mic button using your browser's dictation, with an honest
  note that Chrome's dictation goes through Google. For fully local voice, use
  your system's dictation into the box.
- **Model picker and storage cleanup.** Recommended tiers from WebLLM's live
  catalog, best first. Remove any downloaded model, remove all but the loaded
  one, or let hana free the old model automatically when you switch.
- **Export and import.** The same file format as the Claude version of hana,
  so tasks move between the two.
- **Installable.** A PWA with an offline service worker. Add it to your dock or
  home screen.
- **Settings.** Light, dark, or system theme, the mic switch, auto-clearing
  finished tasks after 7, 30, or 90 days, how many Pau shows, whether unsure
  items start checked, and whether the model loads on open or on demand.
- **Keyboard.** ⌘↵ extract tasks, ↵ accept, ⌘⇧↵ add as is, ⌘⇧M voice, ⌘K model
  panel, ⌘, settings, / jump to the box, 1 and 2 switch tabs, ? help, esc
  closes. Ctrl on Windows and Linux.

## Hardware

WebGPU is required, so Chrome or Edge on a laptop or desktop, or Safari on a
recent Mac. On a 16 GB machine the 8B tier (Qwen3.5 9B or Qwen3 8B) is the
sweet spot. Phones should stay in the light tier.

## Running your own copy

The site is static files. Clone the repo and serve the folder with any web
server, or publish it with GitHub Pages. Opening `index.html` straight from
the file system will not work, because browsers block module imports there.

To ship a model inside your copy so the first run needs no download at all,
run `./fetch-model.sh`. It places the default model's weights under `models/`,
which is ignored by git because the files are too large for GitHub. hana
detects them and loads that model from your own site.

## Updating the engine

`vendor/web-llm.js` is a single-file bundle of `@mlc-ai/web-llm`. To refresh
it to a newer release, which also refreshes the model catalog:

```
npm install @mlc-ai/web-llm@latest
npx esbuild node_modules/@mlc-ai/web-llm/lib/index.js --bundle --format=esm --platform=browser --minify --outfile=vendor/web-llm.js
```

## License

MIT. See [LICENSE](LICENSE).

Built with Claude by [Olin Lagon](https://www.linkedin.com/in/olinlagon/).
The Claude-powered version lives at [olagon/hana](https://github.com/olagon/hana).
