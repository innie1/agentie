import '../config/local_ai_config.dart';
import '../inference/local_ai_attachment.dart';
import '../inference/local_gemma_service.dart';
import 'cloud_inference_gateway.dart';

enum BrainRoute { local, cloud }

class BrainRequest {
  const BrainRequest({
    required this.prompt,
    this.attachments = const [],
    this.requiresFreshInternetData = false,
    this.requiresExternalAction = false,
    this.allowCloudFallback = true,
    this.allowAttachmentsInCloud = false,
    this.startNewConversation = false,
  });

  final String prompt;
  final List<LocalAiAttachment> attachments;
  final bool requiresFreshInternetData;
  final bool requiresExternalAction;
  final bool allowCloudFallback;
  final bool allowAttachmentsInCloud;
  final bool startNewConversation;
}

class BrainChunk {
  const BrainChunk({required this.route, required this.chunk});

  final BrainRoute route;
  final LocalAiChunk chunk;
}

class BrainRoutingException implements Exception {
  const BrainRoutingException(this.message, [this.cause]);

  final String message;
  final Object? cause;

  @override
  String toString() => 'BrainRoutingException: $message';
}

/// Local-first decision layer for Agentie.
///
/// Normal conversation, private files, drafting, summarization, reasoning, and
/// document work stay on-device. Only fresh internet data, connected-service
/// actions, or an explicitly permitted recovery path use the cloud gateway.
class AgentBrainService {
  const AgentBrainService({
    required this.config,
    required this.local,
    this.cloud,
  });

  final LocalAiConfig config;
  final LocalGemmaService local;
  final CloudInferenceGateway? cloud;

  BrainRoute chooseRoute(BrainRequest request) {
    if (request.requiresFreshInternetData || request.requiresExternalAction) {
      return BrainRoute.cloud;
    }
    return BrainRoute.local;
  }

  Stream<BrainChunk> stream(BrainRequest request) async* {
    final route = chooseRoute(request);
    if (route == BrainRoute.cloud) {
      yield* _streamCloud(request);
      return;
    }

    try {
      await for (final chunk in local.stream(
        LocalInferenceRequest(
          prompt: request.prompt,
          attachments: request.attachments,
          startNewConversation: request.startNewConversation,
        ),
      )) {
        yield BrainChunk(route: BrainRoute.local, chunk: chunk);
      }
    } catch (error) {
      final mayFallback =
          config.allowAutomaticCloudFallback &&
          request.allowCloudFallback &&
          cloud != null &&
          (request.attachments.isEmpty || request.allowAttachmentsInCloud);
      if (!mayFallback) {
        throw BrainRoutingException(
          'The local brain failed and cloud fallback is unavailable or blocked.',
          error,
        );
      }
      yield* _streamCloud(request);
    }
  }

  Stream<BrainChunk> _streamCloud(BrainRequest request) async* {
    final gateway = cloud;
    if (gateway == null) {
      throw const BrainRoutingException(
        'This request needs an outside API, but no cloud gateway is configured.',
      );
    }
    if (request.attachments.isNotEmpty && !request.allowAttachmentsInCloud) {
      throw const BrainRoutingException(
        'Private attachments are blocked from leaving the device.',
      );
    }
    // AgentieCloudGateway is intentionally text-only. A host can implement a
    // different gateway when the user explicitly approves attachment upload.
    await for (final chunk in gateway.streamText(request.prompt)) {
      yield BrainChunk(route: BrainRoute.cloud, chunk: chunk);
    }
  }
}
