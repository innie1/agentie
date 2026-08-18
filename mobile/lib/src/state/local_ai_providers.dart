import 'dart:async';

import 'package:flutter_gemma/flutter_gemma.dart' hide ModelStorageException;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../brain/agent_brain_service.dart';
import '../brain/cloud_inference_gateway.dart';
import '../config/local_ai_config.dart';
import '../download/model_download_service.dart';
import '../export/document_export_service.dart';
import '../inference/local_gemma_service.dart';
import 'local_ai_state.dart';

final localAiConfigProvider = Provider<LocalAiConfig>(
  (ref) => LocalAiConfig.fromEnvironment(),
);

final modelDownloadServiceProvider = Provider<ModelDownloadService>(
  (ref) => ModelDownloadService(),
);

final localGemmaServiceProvider = Provider<LocalGemmaService>((ref) {
  final service = LocalGemmaService(ref.watch(localAiConfigProvider));
  ref.onDispose(() => unawaited(service.dispose()));
  return service;
});

/// Override this provider in the host app to enable approved cloud work.
/// Leaving it null guarantees that all supported work remains on-device.
final cloudInferenceGatewayProvider = Provider<CloudInferenceGateway?>(
  (ref) => null,
);

final agentBrainServiceProvider = Provider<AgentBrainService>((ref) {
  return AgentBrainService(
    config: ref.watch(localAiConfigProvider),
    local: ref.watch(localGemmaServiceProvider),
    cloud: ref.watch(cloudInferenceGatewayProvider),
  );
});

final documentExportServiceProvider = Provider<DocumentExportService>(
  (ref) => const DocumentExportService(),
);

final localAiControllerProvider =
    NotifierProvider<LocalAiController, LocalAiState>(LocalAiController.new);

class LocalAiController extends Notifier<LocalAiState> {
  Future<void>? _initializing;

  ModelDownloadService get _downloader =>
      ref.read(modelDownloadServiceProvider);
  LocalGemmaService get _local => ref.read(localGemmaServiceProvider);
  AgentBrainService get _brain => ref.read(agentBrainServiceProvider);
  DocumentExportService get _exporter =>
      ref.read(documentExportServiceProvider);

  @override
  LocalAiState build() => const LocalAiState();

  /// Verifies/downloads the model and loads one accelerated LiteRT-LM engine.
  Future<void> initialize() {
    if (_local.isReady) {
      state = state.copyWith(
        phase: LocalAiPhase.ready,
        activeBackend: _backendName(_local.activeBackend),
        errorMessage: null,
      );
      return Future.value();
    }
    return _initializing ??= _initialize().whenComplete(() {
      _initializing = null;
    });
  }

  Future<void> _initialize() async {
    String? readyPath;
    try {
      await for (final progress in _downloader.ensureModel(
        ref.read(localAiConfigProvider),
      )) {
        state = state.withDownload(progress);
        if (progress.status == ModelDownloadStatus.ready) {
          readyPath = progress.localPath;
        }
        if (progress.status == ModelDownloadStatus.cancelled) return;
      }
      if (readyPath == null) {
        throw const ModelStorageException(
          'The model download ended without a usable file.',
        );
      }
      state = state.copyWith(phase: LocalAiPhase.loadingModel);
      await _local.load(readyPath);
      state = state.copyWith(
        phase: LocalAiPhase.ready,
        modelPath: readyPath,
        activeBackend: _backendName(_local.activeBackend),
        errorMessage: null,
      );
    } catch (error) {
      state = state.copyWith(
        phase: LocalAiPhase.error,
        errorMessage: _friendly(error),
      );
      rethrow;
    }
  }

  /// Streams a response and exposes each partial token through [state].
  Future<void> send(BrainRequest request) async {
    final route = _brain.chooseRoute(request);
    if (route == BrainRoute.local && !_local.isReady) {
      await initialize();
    }

    state = state.copyWith(
      phase: LocalAiPhase.generating,
      route: route,
      response: '',
      thinking: '',
      functionCalls: const [],
      exportedDocument: null,
      errorMessage: null,
    );
    try {
      await for (final event in _brain.stream(request)) {
        switch (event.chunk.type) {
          case LocalAiChunkType.text:
            state = state.copyWith(
              route: event.route,
              response: state.response + event.chunk.content,
            );
            break;
          case LocalAiChunkType.thinking:
            state = state.copyWith(
              route: event.route,
              thinking: state.thinking + event.chunk.content,
            );
            break;
          case LocalAiChunkType.functionCall:
            state = state.copyWith(
              route: event.route,
              functionCalls: [...state.functionCalls, event.chunk.content],
            );
            break;
        }
      }
      state = state.copyWith(phase: LocalAiPhase.ready);
    } catch (error) {
      state = state.copyWith(
        phase: LocalAiPhase.error,
        errorMessage: _friendly(error),
      );
      rethrow;
    }
  }

  Future<void> stop() async {
    _downloader.cancel();
    await _local.stopGeneration();
    state = state.copyWith(
      phase: _local.isReady ? LocalAiPhase.ready : LocalAiPhase.cancelled,
    );
  }

  Future<void> resetConversation() async {
    if (!_local.isReady) await initialize();
    await _local.resetConversation();
    state = state.copyWith(
      phase: LocalAiPhase.ready,
      response: '',
      thinking: '',
      functionCalls: const [],
      route: null,
      errorMessage: null,
    );
  }

  Future<ExportedDocument> exportResponse({
    required String basename,
    required ExportFormat format,
    String? title,
  }) async {
    final content = state.response;
    state = state.copyWith(
      phase: LocalAiPhase.exporting,
      exportedDocument: null,
      errorMessage: null,
    );
    try {
      final document = await _exporter.export(
        basename: basename,
        markdown: content,
        format: format,
        title: title,
      );
      state = state.copyWith(
        phase: _local.isReady ? LocalAiPhase.ready : LocalAiPhase.idle,
        exportedDocument: document,
      );
      return document;
    } catch (error) {
      state = state.copyWith(
        phase: LocalAiPhase.error,
        errorMessage: _friendly(error),
      );
      rethrow;
    }
  }

  String? _backendName(PreferredBackend? backend) =>
      backend?.name.toUpperCase();

  String _friendly(Object error) {
    return switch (error) {
      ModelStorageException(:final message) => message,
      LocalInferenceException(:final message) => message,
      BrainRoutingException(:final message) => message,
      CloudInferenceException(:final message) => message,
      DocumentExportException(:final message) => message,
      _ => 'Local AI operation failed. Please retry.',
    };
  }
}
