# Test PDF Annotation

Example Android app that displays PDFs with [PDF.js](https://mozilla.github.io/pdf.js/)
inside a WebView and adds an annotation layer on top. It is a testbed for future
experiments, not a production viewer.

## Features

- Renders PDFs with PDF.js (pages render lazily as they scroll into view).
- Annotation tools: **Pen** (freehand ink), **Mark** (rectangle highlight),
  **Note** (sticky note with text), **Erase**, plus **Undo** and **Clear**.
- Five colors, zoom in/out, tap the zoom label to fit width.
- Annotations are saved per document as JSON in app-private storage.
- Opens a bundled `sample.pdf` at start; **Open** picks any PDF through the system
  file picker. The app also shows up as a handler for "Open with…" on PDFs.

## How it fits together

```
app/src/main/
├── java/com/example/pdfannotation/
│   ├── MainActivity.kt      WebView host, asset/document serving, JS bridge
│   └── AnnotationStore.kt   Saves annotation JSON per document
└── assets/
    ├── sample.pdf
    └── viewer/              index.html, viewer.css, viewer.js (PDF.js + annotation layer)
```

- **PDF.js is not checked in.** The `preparePdfjsAssets` Gradle task downloads
  `pdfjs-dist` (version set by `pdfjsVersion` in `gradle.properties`) from npm and
  extracts the legacy build, worker, cmaps, standard fonts and wasm decoders into a
  generated assets directory (`/assets/pdfjs/` at runtime).
- The WebView loads everything from `https://appassets.androidplatform.net` using
  `WebViewAssetLoader`, so ES modules and the PDF.js worker work without file:// access.
  `/assets/…` serves bundled assets; `/document/…` streams the PDF the user opened
  from its `content://` URI.
- `viewer.js` calls `AndroidBridge` (`getInitialDocument`, `openFilePicker`,
  `loadAnnotations`, `saveAnnotations`). When the bridge is absent (desktop browser),
  it falls back to a file input and `localStorage`.
- Each page has an `<svg class="annotation-layer">` whose viewBox is the page's
  unscaled size in PDF points (origin top-left), so stored coordinates don't depend on
  zoom. The JSON format is documented at the top of `viewer.js`. Annotations are
  stored alongside the PDF, not written into the PDF file itself.

## Building

GitHub Actions (`.github/workflows/build-apk.yml`) builds debug and release APKs on
every push and pull request, and uploads them as workflow artifacts
(`pdf-annotation-debug`, `pdf-annotation-release`). The release APK is signed with
the debug key so it can be sideloaded.

Locally (JDK 17+ and the Android SDK required):

```sh
./gradlew assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

Debug builds enable WebView remote debugging, so you can inspect the viewer from
`chrome://inspect`.

### Trying the viewer in a desktop browser

```sh
./gradlew :app:preparePdfjsAssets
mkdir -p /tmp/site/assets
cp -r app/src/main/assets/* app/build/generated/pdfjs-assets/pdfjs /tmp/site/assets/
cd /tmp/site && python3 -m http.server 8000
# open http://localhost:8000/assets/viewer/index.html
```
