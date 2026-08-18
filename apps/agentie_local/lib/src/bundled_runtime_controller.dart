import 'dart:convert';
import 'dart:io';

import 'package:agentie_mobile_ai/agentie_mobile_ai.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

enum BundledRuntimePhase {
  checking,
  preparing,
  loading,
  ready,
  development,
  error,
}

class BundledRuntimeState {
  const BundledRuntimeState({
    this.phase = BundledRuntimePhase.checking,
    this.progress,
    this.modelName,
    this.backend,
    this.error,
  });

  final BundledRuntimePhase phase;
  final int? progress;
  final String? modelName;
  final String? backend;
  final String? error;

  bool get isReady => phase == BundledRuntimePhase.ready;
  bool get mayShowInterface =>
      isReady || phase == BundledRuntimePhase.development;

  BundledRuntimeState copyWith({
    BundledRuntimePhase? phase,
    int? progress,
    String? modelName,
    String? backend,
    String? error,
  }) {
    return BundledRuntimeState(
      phase: phase ?? this.phase,
      progress: progress ?? this.progress,
      modelName: modelName ?? this.modelName,
      backend: backend ?? this.backend,
      error: error,
    );
  }
}

final bundledRuntimeControllerProvider =
    NotifierProvider<BundledRuntimeController, BundledRuntimeState>(
      BundledRuntimeController.new,
    );

class BundledRuntimeController extends Notifier<BundledRuntimeState> {
  Future<void>? _preparing;

  @override
  BundledRuntimeState build() => const BundledRuntimeState();

  Future<void> prepare() {
    return _preparing ??= _prepare().whenComplete(() => _preparing = null);
  }

  Future<void> _prepare() async {
    const allowModellessDevelopment = bool.fromEnvironment(
      'AGENTIE_ALLOW_MODELLESS_DEV',
    );
    try {
      final manifestText = await rootBundle.loadString(
        'assets/models/model-manifest.json',
      );
      final manifest = jsonDecode(manifestText) as Map<String, dynamic>;
      if (manifest['bundled'] != true) {
        if (allowModellessDevelopment) {
          state = const BundledRuntimeState(
            phase: BundledRuntimePhase.development,
            error: 'Development mode: no local model is packaged.',
          );
          return;
        }
        throw const FormatException(
          'No local model is packaged. Run tool/bundle_model.dart before a release build.',
        );
      }

      final expectedTarget = Platform.isWindows ? 'desktop' : 'mobile';
      if (manifest['target'] != expectedTarget) {
        throw FormatException(
          'This package contains a ${manifest['target']} model, not a '
          '$expectedTarget model.',
        );
      }
      final target = manifest['model'] as Map<String, dynamic>?;
      if (target == null) {
        throw const FormatException(
          'Model manifest has no model configuration.',
        );
      }
      final filename = target['filename']?.toString() ?? '';
      final expectedBytes = target['expectedBytes'] as int?;
      final expectedHash = target['sha256']?.toString().toLowerCase() ?? '';
      if (!filename.toLowerCase().endsWith('.litertlm')) {
        throw const FormatException('Bundled model must be a .litertlm file.');
      }

      state = BundledRuntimeState(
        phase: BundledRuntimePhase.checking,
        modelName: filename,
      );
      final local = ref.read(localGemmaServiceProvider);
      if (Platform.isWindows) {
        final modelPath = p.join(
          File(Platform.resolvedExecutable).parent.path,
          'data',
          'flutter_assets',
          'assets',
          'models',
          filename,
        );
        await _verifyFile(File(modelPath), expectedBytes, expectedHash);
        state = state.copyWith(phase: BundledRuntimePhase.loading);
        await local.load(modelPath);
      } else {
        final assetPath = 'assets/models/$filename';
        final assets = await AssetManifest.loadFromAssetBundle(rootBundle);
        if (!assets.listAssets().contains(assetPath)) {
          throw FileSystemException('Bundled model is missing', assetPath);
        }
        state = state.copyWith(
          phase: BundledRuntimePhase.preparing,
          progress: 0,
        );
        await local.loadAsset(
          assetPath,
          onProgress: (percentage) {
            state = state.copyWith(
              phase: BundledRuntimePhase.preparing,
              progress: percentage,
            );
          },
        );

        final documents = await getApplicationDocumentsDirectory();
        await _verifyFile(
          File(p.join(documents.path, filename)),
          expectedBytes,
          expectedHash,
        );
      }

      state = BundledRuntimeState(
        phase: BundledRuntimePhase.ready,
        progress: 100,
        modelName: filename,
        backend: local.activeBackend?.name.toUpperCase(),
      );
    } catch (error) {
      state = BundledRuntimeState(
        phase: BundledRuntimePhase.error,
        modelName: state.modelName,
        error: _friendly(error),
      );
    }
  }

  Future<void> _verifyFile(
    File file,
    int? expectedBytes,
    String expectedHash,
  ) async {
    if (!await file.exists()) {
      throw FileSystemException('Bundled model file does not exist', file.path);
    }
    final length = await file.length();
    if (length == 0 || (expectedBytes != null && length != expectedBytes)) {
      throw FileSystemException(
        'Bundled model has an unexpected size ($length bytes)',
        file.path,
      );
    }
    if (expectedHash.isNotEmpty) {
      final actual = await sha256.bind(file.openRead()).first;
      if (actual.toString().toLowerCase() != expectedHash) {
        throw FileSystemException('Bundled model checksum failed', file.path);
      }
    }
  }

  String _friendly(Object error) {
    if (error is LocalInferenceException) return error.message;
    if (error is FileSystemException) {
      return '${error.message}${error.path == null ? '' : ': ${error.path}'}';
    }
    if (error is FormatException) return error.message;
    return 'The bundled local AI could not be prepared: $error';
  }
}
