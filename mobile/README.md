# Agentie mobile local AI

This package is the local-first AI layer for the future Agentie Flutter app. The
repository did not previously contain a Flutter target, so it is isolated in
`mobile/` and does not change the current web UI.

It provides:

- resumable, verified model downloads into app-private Documents storage;
- Gemma 4 E4B text, image, scanned-PDF, and WAV inference through LiteRT-LM;
- GPU/NPU preference with LiteRT-LM's backend fallback;
- token streaming and one Riverpod state/controller API;
- local-first routing with explicit cloud boundaries;
- real PDF, DOCX, Markdown, and UTF-8 text exports.

## Important format and device constraints

LiteRT-LM consumes `.litertlm` bundles, not GGUF. Agentie therefore validates
and installs the Gemma 4 `.litertlm` model. Supporting `.gguf` would require a
second runtime such as llama.cpp and is deliberately not mixed into this
engine.

The default Gemma 4 E4B bundle is about 3.66 GB. Test on a modern physical
arm64 phone with enough free storage and memory. Android LiteRT-LM builds must
target `arm64-v8a`; iOS device builds must target arm64. Audio input must be a
valid WAV file. Images can be passed directly, and PDF documents are rasterized
locally into at most four pages by default.

## Add to an existing Flutter app

Copy this package into the Flutter workspace and use it as a path dependency:

```yaml
dependencies:
  agentie_mobile_ai:
    path: ../agentie/mobile
```

Wrap the application in `ProviderScope`, then start model setup from an
appropriate splash/settings flow:

```dart
await ref.read(localAiControllerProvider.notifier).initialize();

final state = ref.watch(localAiControllerProvider);
final percent = state.downloadPercentage; // null when server size is unknown
final downloaded = state.downloadedBytes;
final total = state.totalBytes;
```

The controller exposes the full lifecycle through `LocalAiPhase`: checking,
downloading, verifying, loading, ready, generating, exporting, cancelled, and
error. Calling `stop()` cancels either a model download or active generation.

## Stream a local multimodal request

```dart
final controller = ref.read(localAiControllerProvider.notifier);

await controller.send(
  BrainRequest(
    prompt: 'Summarize this document and list the important actions.',
    attachments: [
      LocalAiAttachment.documentPath(scannedPdfPath),
    ],
  ),
);

// Rebuild the chat bubble from state.response while tokens arrive.
final markdown = ref.read(localAiControllerProvider).response;
```

For images, use `LocalAiAttachment.imagePath(path)` or construct an attachment
with bytes. For voice recordings, use `LocalAiAttachment.audioPath(wavPath)`.
The bytes remain on-device on the normal route.

## Local-first brain and approved cloud work

Normal conversation, private document analysis, drafting, summarization, and
reasoning use Gemma locally. Mark only genuinely outside work explicitly:

```dart
BrainRequest(
  prompt: 'What is the weather in Lagos now?',
  requiresFreshInternetData: true,
);

BrainRequest(
  prompt: 'Send the approved email.',
  requiresExternalAction: true,
);
```

Cloud access is disabled until the host app overrides the gateway provider:

```dart
ProviderScope(
  overrides: [
    cloudInferenceGatewayProvider.overrideWithValue(
      AgentieCloudGateway(
        baseUri: Uri.parse('https://api.example.com'),
        accessTokenProvider: authRepository.accessToken,
        agentIdProvider: agentRepository.activeAgentId,
      ),
    ),
  ],
  child: const AgentieApp(),
);
```

The included Agentie gateway calls the existing `/api/tasks` endpoint and does
not persist credentials. Attachments are blocked from cloud fallback unless
`allowAttachmentsInCloud` is explicitly enabled. The supplied gateway is
text-only, so an attachment-upload implementation must be added separately
with a clear user approval step.

## Export the generated answer

```dart
final file = await controller.exportResponse(
  basename: 'Ten habits for personal growth',
  title: 'Ten habits for personal growth',
  format: ExportFormat.pdf, // pdf, docx, markdown, or text
);

print(file.path); // pass to the app's viewer or share sheet
```

`previewPdf(file.path)` uses the native print/PDF preview. DOCX output is a real
OpenXML zip package rather than Markdown renamed to `.docx`. To support every
Unicode glyph in PDF output, bundle Noto Sans and inject a `fontLoader` when
overriding `documentExportServiceProvider`.

## Build-time model configuration

The public LiteRT-LM community model is the default. Production builds should
use a controlled HTTPS CDN and a known SHA-256:

```powershell
flutter run `
  --dart-define=GEMMA_MODEL_URL=https://cdn.example.com/gemma-4-E4B-it.litertlm `
  --dart-define=GEMMA_MODEL_FILENAME=gemma-4-E4B-it.litertlm `
  --dart-define=GEMMA_MODEL_BYTES=3659530240 `
  --dart-define=GEMMA_MODEL_SHA256=YOUR_EXPECTED_SHA256 `
  --dart-define=GEMMA_BACKEND=auto
```

Do not ship a private Hugging Face token in `--dart-define`; compile-time values
can be extracted from an application. Prefer a public/signed CDN URL or inject
a short-lived token from secure authentication at runtime.

## Native host setup

Android:

- declare `android.permission.INTERNET`;
- restrict the app build to `arm64-v8a` for `.litertlm` inference;
- inside `<application>`, declare optional native libraries
  `libvndksupport.so`, `libOpenCL.so`, `libOpenCL-car.so`, and
  `libOpenCL-pixel.so` with `android:required="false"` for GPU loading;
- no storage permission is needed for the app Documents directory.

iOS:

- set `platform :ios, '16.0'` and `use_frameworks! :linkage => :static`;
- enable the increased-memory and extended-virtual-addressing entitlements for
  this large model;
- test multimodal inference on a physical arm64 device;
- add microphone/camera/photo-library purpose strings only when the host UI
  captures those inputs.

Run validation from this directory with:

```powershell
flutter pub get
flutter analyze
flutter test
```
