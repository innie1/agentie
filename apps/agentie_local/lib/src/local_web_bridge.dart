import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:agentie_mobile_ai/agentie_mobile_ai.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'bundled_runtime_controller.dart';

class LocalWebBridge {
  LocalWebBridge({required this.ref, required this.webView});

  final WidgetRef ref;
  final InAppWebViewController webView;

  void install() {
    webView.addJavaScriptHandler(
      handlerName: 'agentieLocal',
      callback: _handle,
    );
  }

  Future<Map<String, dynamic>> _handle(List<dynamic> arguments) async {
    if (arguments.isEmpty || arguments.first is! Map) {
      return const {'error': 'Invalid local bridge request.'};
    }
    final request = Map<String, dynamic>.from(arguments.first as Map);
    final action = request['action']?.toString();
    try {
      return switch (action) {
        'status' => _status(),
        'chat' => await _chat(request),
        'stop' => await _stop(),
        'reset' => await _reset(),
        _ => const {'error': 'Unknown local bridge action.'},
      };
    } catch (error) {
      return {'error': _friendly(error)};
    }
  }

  Map<String, dynamic> _status() {
    final runtime = ref.read(bundledRuntimeControllerProvider);
    return {
      'available': true,
      'ready': runtime.isReady,
      'phase': runtime.phase.name,
      'model': runtime.modelName,
      'backend': runtime.backend,
      if (runtime.error != null) 'error': runtime.error,
    };
  }

  Future<Map<String, dynamic>> _chat(Map<String, dynamic> request) async {
    final runtime = ref.read(bundledRuntimeControllerProvider);
    if (!runtime.isReady) {
      return {
        'error': runtime.error ?? 'The bundled local model is not ready.',
      };
    }
    final requestId = request['requestId']?.toString() ?? '';
    final payload = request['payload'] is Map
        ? Map<String, dynamic>.from(request['payload'] as Map)
        : const <String, dynamic>{};
    final prompt = payload['prompt']?.toString().trim() ?? '';
    final attachments = _decodeAttachments(payload['attachments']);
    if (prompt.isEmpty && attachments.isEmpty) {
      return const {'error': 'A message or attachment is required.'};
    }

    final composedPrompt = _composePrompt(payload, prompt);
    final local = ref.read(localGemmaServiceProvider);
    final complete = StringBuffer();
    await for (final chunk in local.stream(
      LocalInferenceRequest(
        prompt: composedPrompt,
        attachments: attachments,
        startNewConversation: true,
      ),
    )) {
      if (chunk.type != LocalAiChunkType.text || chunk.content.isEmpty) {
        continue;
      }
      complete.write(chunk.content);
      await _sendChunk(requestId, chunk.content);
    }
    final text = complete.toString();
    final document = await _exportDocument(payload, text);
    return {'text': text, 'route': 'local', 'document': ?document};
  }

  String _composePrompt(Map<String, dynamic> payload, String prompt) {
    final agentName = payload['agentName']?.toString().trim();
    final systemPrompt = payload['systemPrompt']?.toString().trim();
    final history = payload['history'] is List
        ? (payload['history'] as List).whereType<Map>().toList()
        : const <Map>[];
    final selected = history.length <= 6
        ? history
        : history.sublist(history.length - 6);

    final buffer = StringBuffer();
    if (agentName != null && agentName.isNotEmpty) {
      buffer.writeln('Agent name: $agentName');
    }
    if (systemPrompt != null && systemPrompt.isNotEmpty) {
      buffer.writeln('Agent role: ${_limit(systemPrompt, 900)}');
    }
    if (selected.isNotEmpty) {
      buffer.writeln('\nRecent conversation context:');
      for (final entry in selected) {
        final role = entry['role'] == 'assistant' ? 'Assistant' : 'User';
        buffer.writeln(
          '$role: ${_limit(entry['content']?.toString() ?? '', 900)}',
        );
      }
    }
    buffer.writeln('\nCurrent user message: $prompt');
    if (payload['documentRequest'] is Map) {
      buffer.write(
        '\nWrite the complete document content in clean Markdown. Return only '
        'the document itself, without a preamble or download instructions.',
      );
    } else {
      buffer.write('\nAnswer the current message naturally and concisely.');
    }
    return buffer.toString();
  }

  String _limit(String value, int maximum) =>
      value.length <= maximum ? value : value.substring(0, maximum);

  List<LocalAiAttachment> _decodeAttachments(dynamic rawAttachments) {
    if (rawAttachments is! List) return const [];
    final result = <LocalAiAttachment>[];
    for (final raw in rawAttachments.take(4)) {
      if (raw is! Map) continue;
      final attachment = Map<String, dynamic>.from(raw);
      final encoded = attachment['base64']?.toString() ?? '';
      final filename = attachment['name']?.toString() ?? 'attachment';
      final mimeType = attachment['mimeType']?.toString().toLowerCase() ?? '';
      if (encoded.isEmpty) continue;
      late final List<int> decoded;
      try {
        decoded = base64Decode(encoded);
      } on FormatException {
        throw const LocalInferenceException(
          'An attachment contains invalid encoded data.',
        );
      }
      if (decoded.length > 12 * 1024 * 1024) {
        throw const LocalInferenceException(
          'Local attachments must be 12 MB or smaller.',
        );
      }

      final kind = mimeType == 'application/pdf'
          ? LocalAttachmentKind.scannedDocument
          : mimeType == 'audio/wav' || mimeType == 'audio/x-wav'
          ? LocalAttachmentKind.audio
          : mimeType.startsWith('image/')
          ? LocalAttachmentKind.image
          : throw LocalInferenceException(
              'Unsupported local attachment: $filename. Use an image, PDF, or WAV file.',
            );
      result.add(
        LocalAiAttachment(
          kind: kind,
          bytes: Uint8List.fromList(decoded),
          filename: filename,
        ),
      );
    }
    return result;
  }

  Future<Map<String, dynamic>?> _exportDocument(
    Map<String, dynamic> payload,
    String markdown,
  ) async {
    if (payload['documentRequest'] is! Map) return null;
    final request = Map<String, dynamic>.from(
      payload['documentRequest'] as Map,
    );
    final formatName = request['format']?.toString() ?? '';
    final format = switch (formatName) {
      'pdf' => ExportFormat.pdf,
      'text' => ExportFormat.text,
      'markdown' => ExportFormat.markdown,
      'docx' => ExportFormat.docx,
      _ => throw const LocalInferenceException(
        'The requested document format is not supported.',
      ),
    };
    final basename = request['basename']?.toString().trim();
    final title = request['title']?.toString().trim();
    final exported = await const DocumentExportService().export(
      basename: basename == null || basename.isEmpty
          ? 'Agentie document'
          : basename,
      markdown: markdown,
      format: format,
      title: title == null || title.isEmpty ? null : title,
    );
    final bytes = await File(exported.path).readAsBytes();
    return {
      'id': 'local-${DateTime.now().microsecondsSinceEpoch}',
      'name': exported.filename,
      'extension': exported.filename.split('.').last,
      'size_bytes': exported.sizeBytes,
      'mime_type': exported.mimeType,
      'preview_text': markdown,
      'data_base64': base64Encode(bytes),
      'local_path': exported.path,
    };
  }

  Future<void> _sendChunk(String requestId, String chunk) async {
    if (requestId.isEmpty) return;
    try {
      await webView.evaluateJavascript(
        source:
            'window.__agentieLocalChunk(${jsonEncode(requestId)}, ${jsonEncode(chunk)});',
      );
    } catch (_) {
      // Navigation can replace the page during generation. The final response
      // is still returned through the JavaScript handler when possible.
    }
  }

  Future<Map<String, dynamic>> _stop() async {
    await ref.read(localGemmaServiceProvider).stopGeneration();
    return const {'stopped': true};
  }

  Future<Map<String, dynamic>> _reset() async {
    await ref.read(localGemmaServiceProvider).resetConversation();
    return const {'reset': true};
  }

  String _friendly(Object error) => switch (error) {
    LocalInferenceException(:final message) => message,
    BrainRoutingException(:final message) => message,
    _ => 'Local AI failed: $error',
  };
}
