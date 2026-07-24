# hana-local

A fully private, on-device task manager. Paste messy text, a whole email,
meeting notes, or one loose line, press **Make tasks**, and a small
open-source language model running in your own browser turns it into a clean
task list.

**Your words never leave this device.** The model runs here, on your machine,
via [WebLLM](https://github.com/mlc-ai/web-llm) over WebGPU. Your tasks are
stored here, in your browser's IndexedDB. No server, no account, no sync.

Usage is counted with Google Analytics (tag `G-6RWQDJYE9C` in `index.html`):
visits, which model is in use (`model_ready`), and how many tasks get added
(`tasks_added` with counts and method). Numbers only. Pasted text, task
titles, notes, projects, and dates are never sent to anyone. Offline or with
a content blocker, the app works identically and nothing is sent.

## Running it

It is all static files, no build step. Serve this folder from any web server
(it needs a secure context, so `localhost` or HTTPS) and open it:

```
python3 -m http.server 8080
```

Requirements: a browser with WebGPU (current Chrome, Edge, or Safari) and
enough memory for the model you pick.

## The bundled model

The default model, Qwen2.5 3B quantized to q4, is about 1.7 GB and is too
large to live in this repository. You have two options after cloning:

1. Run `./fetch-model.sh`. It rebuilds `models/` in place so the app serves
   the model from its own origin and never touches a CDN.
2. Do nothing. The app detects the missing folder and downloads the default
   model once from the public MLC CDN instead, then caches it offline.

Seven models are available in the app, from an 8B for strong machines down
to a 280 MB taster. The models page inside the app describes each one.

## Layout

- `index.html`, `styles.css`, `app.js`: the app (vanilla JS)
- `db.js`: tiny IndexedDB wrapper for tasks and settings
- `llm.js`: WebLLM engine wrapper with grammar-constrained JSON extraction
- `vendor/web-llm.js`: the WebLLM library, hosted locally
- `models/`: the bundled default model, created by `fetch-model.sh`
- `fonts/`: Fraunces, IBM Plex Sans, IBM Plex Mono, hosted locally
- `sw.js`, `manifest.webmanifest`, icons: PWA install and offline app shell
  (bump the cache version in `sw.js` when deploying changes)

## Moving data

Export writes every task (dates, projects, notes, done, Holding Tank state)
to a JSON file. Import reads one back, adding what's new and updating matches
field by field. That file is the backup and transfer path, and it is
compatible with exports from [hana](https://github.com/olagon/hana).

## License

MIT. Built with Claude by Olin Lagon.
