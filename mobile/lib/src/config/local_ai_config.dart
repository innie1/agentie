import 'package:flutter_gemma/flutter_gemma.dart';

/// Acceleration preference for the local model.
enum LocalAiBackend { automatic, gpu, npu, cpu }

extension LocalAiBackendX on LocalAiBackend {
  PreferredBackend? get preferredBackend => switch (this) {
    LocalAiBackend.automatic => null,
    LocalAiBackend.gpu => PreferredBackend.gpu,
    LocalAiBackend.npu => PreferredBackend.npu,
    LocalAiBackend.cpu => PreferredBackend.cpu,
  };
}

/// Immutable configuration for the local Agentie brain.
class LocalAiConfig {
  const LocalAiConfig({
    required this.modelUri,
    this.modelFilename = 'gemma-4-E4B-it.litertlm',
    this.expectedModelBytes,
    this.expectedSha256,
    this.downloadBearerToken,
    this.backend = LocalAiBackend.automatic,
    this.maxContextTokens = 4096,
    this.maxOutputTokens = 1024,
    this.maxImages = 4,
    this.maxPdfPages = 4,
    this.enableSpeculativeDecoding = true,
    this.allowAutomaticCloudFallback = true,
    this.allowInsecureModelUrl = false,
  });

  /// Public LiteRT-LM bundle. Override it with GEMMA_MODEL_URL for your CDN.
  static const defaultModelUrl =
      'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/'
      'resolve/main/gemma-4-E4B-it.litertlm';

  final Uri modelUri;
  final String modelFilename;
  final int? expectedModelBytes;
  final String? expectedSha256;
  final String? downloadBearerToken;
  final LocalAiBackend backend;
  final int maxContextTokens;
  final int maxOutputTokens;
  final int maxImages;
  final int maxPdfPages;
  final bool enableSpeculativeDecoding;
  final bool allowAutomaticCloudFallback;
  final bool allowInsecureModelUrl;

  factory LocalAiConfig.fromEnvironment() {
    const url = String.fromEnvironment(
      'GEMMA_MODEL_URL',
      defaultValue: defaultModelUrl,
    );
    const filename = String.fromEnvironment(
      'GEMMA_MODEL_FILENAME',
      defaultValue: 'gemma-4-E4B-it.litertlm',
    );
    const sha = String.fromEnvironment('GEMMA_MODEL_SHA256');
    const token = String.fromEnvironment('HUGGINGFACE_TOKEN');
    const expectedBytes = int.fromEnvironment(
      'GEMMA_MODEL_BYTES',
      defaultValue: 3659530240,
    );
    const backendName = String.fromEnvironment(
      'GEMMA_BACKEND',
      defaultValue: 'auto',
    );

    return LocalAiConfig(
      modelUri: Uri.parse(url),
      modelFilename: filename,
      expectedModelBytes: expectedBytes > 0 ? expectedBytes : null,
      expectedSha256: sha.isEmpty ? null : sha.toLowerCase(),
      downloadBearerToken: token.isEmpty ? null : token,
      backend: switch (backendName.toLowerCase()) {
        'gpu' => LocalAiBackend.gpu,
        'npu' => LocalAiBackend.npu,
        'cpu' => LocalAiBackend.cpu,
        _ => LocalAiBackend.automatic,
      },
    );
  }

  void validate() {
    if (!modelFilename.toLowerCase().endsWith('.litertlm')) {
      throw ArgumentError.value(
        modelFilename,
        'modelFilename',
        'Gemma 4 must use a .litertlm bundle.',
      );
    }
    if (!modelUri.hasScheme || modelUri.host.isEmpty) {
      throw ArgumentError.value(modelUri, 'modelUri', 'Invalid model URL.');
    }
    if (!allowInsecureModelUrl && modelUri.scheme != 'https') {
      throw ArgumentError('Model downloads must use HTTPS.');
    }
    if (maxContextTokens < 1024) {
      throw ArgumentError.value(
        maxContextTokens,
        'maxContextTokens',
        'LiteRT-LM requires a context window of at least 1024 tokens.',
      );
    }
    if (maxOutputTokens < 1 || maxOutputTokens >= maxContextTokens) {
      throw ArgumentError.value(
        maxOutputTokens,
        'maxOutputTokens',
        'Must be positive and smaller than maxContextTokens.',
      );
    }
  }
}
