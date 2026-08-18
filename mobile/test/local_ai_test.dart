import 'package:agentie_mobile_ai/agentie_mobile_ai.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('LocalAiConfig', () {
    test('accepts a secure LiteRT-LM bundle', () {
      final config = LocalAiConfig(
        modelUri: Uri.parse('https://cdn.example.com/model.litertlm'),
        expectedModelBytes: 42,
      );

      expect(config.validate, returnsNormally);
    });

    test('rejects GGUF because LiteRT-LM cannot execute it', () {
      final config = LocalAiConfig(
        modelUri: Uri.parse('https://cdn.example.com/model.gguf'),
        modelFilename: 'model.gguf',
      );

      expect(config.validate, throwsArgumentError);
    });

    test('rejects an insecure production model URL', () {
      final config = LocalAiConfig(
        modelUri: Uri.parse('http://cdn.example.com/model.litertlm'),
      );

      expect(config.validate, throwsArgumentError);
    });
  });

  test('download progress exposes bounded UI percentages', () {
    const progress = ModelDownloadProgress(
      status: ModelDownloadStatus.downloading,
      downloadedBytes: 75,
      totalBytes: 100,
    );

    expect(progress.fraction, 0.75);
    expect(progress.percentage, 75);
    expect(const LocalAiState().withDownload(progress).downloadPercentage, 75);
  });
}
