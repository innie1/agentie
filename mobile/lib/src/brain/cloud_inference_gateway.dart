import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';

import '../inference/local_gemma_service.dart';

abstract interface class CloudInferenceGateway {
  Stream<LocalAiChunk> streamText(String prompt);
}

class CloudInferenceException implements Exception {
  const CloudInferenceException(this.message, [this.cause]);

  final String message;
  final Object? cause;

  @override
  String toString() => 'CloudInferenceException: $message';
}

typedef AsyncStringProvider = Future<String?> Function();

/// Adapter for Agentie's existing `/api/tasks` control-plane endpoint.
///
/// Credentials and agent identity are injected by the host Flutter app. This
/// class never stores tokens and never uploads attachments.
class AgentieCloudGateway implements CloudInferenceGateway {
  AgentieCloudGateway({
    required this.baseUri,
    required this.accessTokenProvider,
    required this.agentIdProvider,
    Dio? dio,
    this.taskTimeout = const Duration(minutes: 2),
  }) : _dio = dio ?? Dio();

  final Uri baseUri;
  final AsyncStringProvider accessTokenProvider;
  final AsyncStringProvider agentIdProvider;
  final Duration taskTimeout;
  final Dio _dio;

  @override
  Stream<LocalAiChunk> streamText(String prompt) async* {
    final token = await accessTokenProvider();
    final agentId = await agentIdProvider();
    if (agentId == null || agentId.isEmpty) {
      throw const CloudInferenceException('No cloud agent is selected.');
    }
    final headers = <String, String>{
      'Content-Type': 'application/json',
      if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
    };

    try {
      final response = await _dio.postUri<Map<String, dynamic>>(
        baseUri.resolve('/api/tasks'),
        data: {'agent_id': agentId, 'instruction': prompt, 'history': const []},
        options: Options(headers: headers),
      );
      final body = response.data ?? const <String, dynamic>{};
      final chat = body['chat'];
      if (chat is Map<String, dynamic>) {
        final result = chat['result']?.toString() ?? '';
        if (result.isNotEmpty) yield LocalAiChunk.text(result);
        return;
      }

      final task = body['task'];
      if (task is! Map<String, dynamic> || task['id'] == null) {
        throw const CloudInferenceException(
          'Cloud response did not include a chat or task.',
        );
      }
      final taskId = task['id'].toString();
      final deadline = DateTime.now().add(taskTimeout);
      while (DateTime.now().isBefore(deadline)) {
        await Future<void>.delayed(const Duration(seconds: 1));
        final listResponse = await _dio.getUri<Map<String, dynamic>>(
          baseUri
              .resolve('/api/tasks')
              .replace(queryParameters: {'agent_id': agentId}),
          options: Options(headers: headers),
        );
        final tasks = listResponse.data?['tasks'];
        if (tasks is! List) continue;
        Map<String, dynamic>? current;
        for (final item in tasks.whereType<Map<String, dynamic>>()) {
          if (item['id']?.toString() == taskId) {
            current = item;
            break;
          }
        }
        if (current == null) continue;
        final status = current['status']?.toString();
        if (status == 'done' || status == 'completed') {
          final result =
              current['result']?.toString() ??
              current['result_payload']?['text']?.toString() ??
              jsonEncode(current['result_payload'] ?? const {});
          yield LocalAiChunk.text(result);
          return;
        }
        if (status == 'needs_approval') {
          yield LocalAiChunk.functionCall(
            jsonEncode(current['result_payload'] ?? const {}),
          );
          return;
        }
        if (status == 'failed' || status == 'cancelled') {
          throw CloudInferenceException(
            'Cloud task ended with status: $status',
          );
        }
      }
      throw const CloudInferenceException('Cloud task timed out.');
    } on DioException catch (error) {
      throw CloudInferenceException(
        error.response?.data?.toString() ?? 'Cloud request failed.',
        error,
      );
    }
  }
}
