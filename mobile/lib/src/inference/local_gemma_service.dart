import 'dart:convert';
import 'dart:io';

import 'package:flutter_gemma/flutter_gemma.dart';
import 'package:flutter_gemma_litertlm/flutter_gemma_litertlm.dart';

import '../config/local_ai_config.dart';
import 'local_ai_attachment.dart';

enum LocalGemmaStatus { uninitialized, loading, ready, generating, failed }

enum LocalAiChunkType { text, thinking, functionCall }

class LocalAiChunk {
  const LocalAiChunk({required this.type, required this.content});

  const LocalAiChunk.text(String token)
    : this(type: LocalAiChunkType.text, content: token);

  const LocalAiChunk.thinking(String content)
    : this(type: LocalAiChunkType.thinking, content: content);

  const LocalAiChunk.functionCall(String payload)
    : this(type: LocalAiChunkType.functionCall, content: payload);

  final LocalAiChunkType type;
  final String content;
}

class LocalInferenceRequest {
  const LocalInferenceRequest({
    required this.prompt,
    this.attachments = const [],
    this.startNewConversation = false,
  });

  final String prompt;
  final List<LocalAiAttachment> attachments;
  final bool startNewConversation;

  bool get hasSensitiveAttachments => attachments.isNotEmpty;
}

class LocalInferenceException implements Exception {
  const LocalInferenceException(this.message, [this.cause]);

  final String message;
  final Object? cause;

  @override
  String toString() => 'LocalInferenceException: $message';
}

/// Owns the long-lived LiteRT-LM engine and a persistent Agentie conversation.
class LocalGemmaService {
  LocalGemmaService(this.config)
    : attachmentResolver = LocalAttachmentResolver(
        maxImages: config.maxImages,
        maxPdfPages: config.maxPdfPages,
      );

  final LocalAiConfig config;
  final LocalAttachmentResolver attachmentResolver;

  InferenceModel? _model;
  InferenceChat? _chat;
  bool _sdkInitialized = false;
  bool _isGenerating = false;
  LocalGemmaStatus _status = LocalGemmaStatus.uninitialized;
  Object? _lastError;

  LocalGemmaStatus get status => _status;
  Object? get lastError => _lastError;
  bool get isReady => _status == LocalGemmaStatus.ready;
  PreferredBackend? get activeBackend => _model?.activeBackend;

  Future<void> load(String modelPath) async {
    if (_status == LocalGemmaStatus.ready) return;
    _status = LocalGemmaStatus.loading;
    _lastError = null;
    try {
      final file = File(modelPath);
      if (!await file.exists() || await file.length() == 0) {
        throw const LocalInferenceException(
          'The local model file is missing or incomplete.',
        );
      }
      await _initializeSdk();

      await FlutterGemma.installModel(
        modelType: ModelType.gemma4,
        fileType: ModelFileType.litertlm,
      ).fromFile(modelPath).install();

      await _activateModel();
      _status = LocalGemmaStatus.ready;
    } catch (error) {
      await _failLoading(error);
    }
  }

  /// Installs a model shipped inside the application package.
  ///
  /// Android and iOS copy the large asset using a native streaming channel.
  /// Windows should call [load] with the asset's direct installed file path so
  /// the model is not duplicated or loaded fully into memory.
  Future<void> loadAsset(
    String assetPath, {
    void Function(int percentage)? onProgress,
  }) async {
    if (_status == LocalGemmaStatus.ready) return;
    _status = LocalGemmaStatus.loading;
    _lastError = null;
    try {
      await _initializeSdk();
      var installer = FlutterGemma.installModel(
        modelType: ModelType.gemma4,
        fileType: ModelFileType.litertlm,
      ).fromAsset(assetPath);
      if (onProgress != null) installer = installer.withProgress(onProgress);
      await installer.install();
      await _activateModel();
      _status = LocalGemmaStatus.ready;
    } catch (error) {
      await _failLoading(error);
    }
  }

  Future<void> _initializeSdk() async {
    if (_sdkInitialized) return;
    FlutterGemma.logLevel = GemmaLogLevel.none;
    await FlutterGemma.initialize(
      huggingFaceToken: config.downloadBearerToken,
      inferenceEngines: const [LiteRtLmEngine()],
    );
    _sdkInitialized = true;
  }

  Future<void> _activateModel() async {
    final preferredBackend = config.backend == LocalAiBackend.automatic
        ? (Platform.isAndroid ? PreferredBackend.npu : PreferredBackend.gpu)
        : config.backend.preferredBackend;
    _model = await FlutterGemma.getActiveModel(
      maxTokens: config.maxContextTokens,
      preferredBackend: preferredBackend,
      preferredVisionBackend: PreferredBackend.gpu,
      preferredAudioBackend: PreferredBackend.cpu,
      supportImage: true,
      supportAudio: true,
      maxNumImages: config.maxImages,
      enableSpeculativeDecoding: config.enableSpeculativeDecoding,
      maxConcurrentSessions: 1,
    );
    await _createChat();
  }

  Future<Never> _failLoading(Object error) async {
    _lastError = error;
    _status = LocalGemmaStatus.failed;
    await _closeRuntime();
    throw LocalInferenceException(
      'Gemma could not be initialized on this device.',
      error,
    );
  }

  Future<void> _createChat() async {
    await _chat?.close();
    _chat = await _model!.createChat(
      supportImage: true,
      supportAudio: true,
      modelType: ModelType.gemma4,
      supportsFunctionCalls: true,
      maxOutputTokens: config.maxOutputTokens,
      systemInstruction: _systemInstruction,
    );
  }

  Stream<LocalAiChunk> stream(LocalInferenceRequest request) async* {
    if (_status != LocalGemmaStatus.ready || _chat == null) {
      throw const LocalInferenceException('The local model is not ready.');
    }
    if (_isGenerating) {
      throw const LocalInferenceException(
        'Another local response is still being generated.',
      );
    }
    if (request.prompt.trim().isEmpty && request.attachments.isEmpty) {
      throw const LocalInferenceException(
        'A prompt or attachment is required.',
      );
    }

    _isGenerating = true;
    _status = LocalGemmaStatus.generating;
    try {
      if (request.startNewConversation) await _createChat();
      final input = await attachmentResolver.resolve(request.attachments);
      final message = Message(
        text: request.prompt.trim(),
        isUser: true,
        imageBytes: input.images.isEmpty ? null : input.images.first,
        images: input.images,
        audioBytes: input.audio,
      );
      await _chat!.addQueryChunk(message);

      await for (final response in _chat!.generateChatResponseAsync()) {
        switch (response) {
          case TextResponse(:final token):
            if (token.isNotEmpty) yield LocalAiChunk.text(token);
            break;
          case ThinkingResponse(:final content):
            if (content.isNotEmpty) yield LocalAiChunk.thinking(content);
            break;
          case FunctionCallResponse(:final name, :final args):
            yield LocalAiChunk.functionCall(
              jsonEncode({'name': name, 'arguments': args}),
            );
            break;
          case ParallelFunctionCallResponse(:final calls):
            yield LocalAiChunk.functionCall(
              jsonEncode([
                for (final call in calls)
                  {'name': call.name, 'arguments': call.args},
              ]),
            );
            break;
        }
      }
    } catch (error) {
      _lastError = error;
      throw LocalInferenceException('Local inference failed.', error);
    } finally {
      _isGenerating = false;
      _status = _model == null
          ? LocalGemmaStatus.failed
          : LocalGemmaStatus.ready;
    }
  }

  Future<void> stopGeneration() async {
    await _chat?.stopGeneration();
    _isGenerating = false;
    if (_model != null) _status = LocalGemmaStatus.ready;
  }

  Future<void> resetConversation() => _createChat();

  Future<void> dispose() async {
    await stopGeneration();
    await _closeRuntime();
    _status = LocalGemmaStatus.uninitialized;
  }

  Future<void> _closeRuntime() async {
    await _chat?.close();
    _chat = null;
    await _model?.close();
    _model = null;
  }

  static const _systemInstruction = '''
You are Agentie's private on-device brain. Prefer concise, useful answers.
Treat ordinary conversation as conversation, not as a task. Before creating a
task, routine, external action, or file, confirm the user's intent when it is
ambiguous. Never claim to have current internet data. When fresh data or an
external service is required, explain that the request needs the cloud route.
Return readable Markdown. Protect private attachment contents.
''';
}
