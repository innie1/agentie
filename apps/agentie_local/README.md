# Agentie Local

This is the installable Flutter host for Agentie on Windows, Android, and iOS.
It packages the existing Agentie interface, persists agents and conversations on
the device, and routes normal chat to a bundled LiteRT-LM model. The installed
application does not download its model at runtime.

## Release model policy

Model weights are not committed to Git. Before building a release, obtain a
properly licensed `.litertlm` model and stage it with:

```powershell
dart run tool/bundle_model.dart --source C:\models\gemma-e4b.litertlm --target desktop --variant E4B
```

Use the desktop model for the Windows package. Create a separate mobile package
with a device-appropriate model (E2B is the default because E4B can exceed mobile
store and memory limits):

```powershell
dart run tool/bundle_model.dart --source C:\models\gemma-e2b.litertlm --target mobile --variant E2B
```

The bundler copies the model into the application assets and writes its exact
size and SHA-256 checksum to `assets/models/model-manifest.json`. Startup refuses
to run an absent, corrupt, or wrong-target model.

## Syncing the existing UI

The root web interface remains the UI source of truth. After changing it, run:

```powershell
dart run tool/sync_web_assets.dart
```

External browser libraries are cached under `assets/web/vendor`, so the UI can
start offline. `tool/fetch_vendor.dart` refreshes those pinned local copies when
needed during development; it is never called by the installed application.

## Build

```powershell
flutter pub get
flutter analyze
flutter test
flutter build windows --release
flutter build appbundle --release
```

iOS builds require macOS, Xcode, a signing team, and an App Store provisioning
profile:

```bash
flutter build ipa --release
```

On Windows, Flutter plugins require symbolic-link support. Enable Windows
Developer Mode before running `flutter pub get` or a Windows build.

For UI-only development without model weights, use
`--dart-define=AGENTIE_ALLOW_MODELLESS_DEV=true`. That flag exposes the interface
but deliberately does not report the local AI as ready.

## Runtime behavior

- **Local (default):** normal conversation, agent state, routines, files, and
  inference stay on the device. Local time works without internet.
- **Online when needed:** explicit web/current-information requests and connected
  plugin requests may use the existing online control plane. Live weather and
  sports cards require this mode.
- The model is verified and loaded during first launch. Mobile platforms copy the
  packaged model into application storage once; this is local extraction, not a
  network download.
