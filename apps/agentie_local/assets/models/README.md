# Bundled model input

Release builds must place the appropriate `.litertlm` file in this directory
and set `bundled`, `expectedBytes`, and `sha256` in `model-manifest.json`.

The application never downloads a model at runtime. `tool/bundle_model.dart`
copies and verifies a developer-provided model before packaging.
