import '../brain/agent_brain_service.dart';
import '../download/model_download_service.dart';
import '../export/document_export_service.dart';

enum LocalAiPhase {
  idle,
  checkingModel,
  downloadingModel,
  verifyingModel,
  loadingModel,
  ready,
  generating,
  exporting,
  cancelled,
  error,
}

/// Immutable UI state for model setup, generation, and document export.
class LocalAiState {
  const LocalAiState({
    this.phase = LocalAiPhase.idle,
    this.downloadedBytes = 0,
    this.totalBytes,
    this.modelPath,
    this.activeBackend,
    this.route,
    this.response = '',
    this.thinking = '',
    this.functionCalls = const [],
    this.exportedDocument,
    this.errorMessage,
  });

  final LocalAiPhase phase;
  final int downloadedBytes;
  final int? totalBytes;
  final String? modelPath;
  final String? activeBackend;
  final BrainRoute? route;
  final String response;
  final String thinking;
  final List<String> functionCalls;
  final ExportedDocument? exportedDocument;
  final String? errorMessage;

  bool get isBusy => switch (phase) {
    LocalAiPhase.checkingModel ||
    LocalAiPhase.downloadingModel ||
    LocalAiPhase.verifyingModel ||
    LocalAiPhase.loadingModel ||
    LocalAiPhase.generating ||
    LocalAiPhase.exporting => true,
    _ => false,
  };

  double? get downloadFraction => totalBytes == null || totalBytes == 0
      ? null
      : (downloadedBytes / totalBytes!).clamp(0, 1);

  int? get downloadPercentage =>
      downloadFraction == null ? null : (downloadFraction! * 100).floor();

  LocalAiState copyWith({
    LocalAiPhase? phase,
    int? downloadedBytes,
    Object? totalBytes = _notSet,
    Object? modelPath = _notSet,
    Object? activeBackend = _notSet,
    Object? route = _notSet,
    String? response,
    String? thinking,
    List<String>? functionCalls,
    Object? exportedDocument = _notSet,
    Object? errorMessage = _notSet,
  }) {
    return LocalAiState(
      phase: phase ?? this.phase,
      downloadedBytes: downloadedBytes ?? this.downloadedBytes,
      totalBytes: identical(totalBytes, _notSet)
          ? this.totalBytes
          : totalBytes as int?,
      modelPath: identical(modelPath, _notSet)
          ? this.modelPath
          : modelPath as String?,
      activeBackend: identical(activeBackend, _notSet)
          ? this.activeBackend
          : activeBackend as String?,
      route: identical(route, _notSet) ? this.route : route as BrainRoute?,
      response: response ?? this.response,
      thinking: thinking ?? this.thinking,
      functionCalls: functionCalls ?? this.functionCalls,
      exportedDocument: identical(exportedDocument, _notSet)
          ? this.exportedDocument
          : exportedDocument as ExportedDocument?,
      errorMessage: identical(errorMessage, _notSet)
          ? this.errorMessage
          : errorMessage as String?,
    );
  }

  LocalAiState withDownload(ModelDownloadProgress progress) => copyWith(
    phase: switch (progress.status) {
      ModelDownloadStatus.checking => LocalAiPhase.checkingModel,
      ModelDownloadStatus.downloading => LocalAiPhase.downloadingModel,
      ModelDownloadStatus.verifying => LocalAiPhase.verifyingModel,
      ModelDownloadStatus.ready => LocalAiPhase.loadingModel,
      ModelDownloadStatus.cancelled => LocalAiPhase.cancelled,
    },
    downloadedBytes: progress.downloadedBytes,
    totalBytes: progress.totalBytes,
    modelPath: progress.localPath,
    errorMessage: null,
  );
}

const _notSet = Object();
