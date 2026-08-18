import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import '../config/local_ai_config.dart';

enum ModelDownloadStatus { checking, downloading, verifying, ready, cancelled }

class ModelDownloadProgress {
  const ModelDownloadProgress({
    required this.status,
    required this.downloadedBytes,
    this.totalBytes,
    this.localPath,
  });

  final ModelDownloadStatus status;
  final int downloadedBytes;
  final int? totalBytes;
  final String? localPath;

  double? get fraction => totalBytes == null || totalBytes == 0
      ? null
      : (downloadedBytes / totalBytes!).clamp(0, 1);

  int? get percentage => fraction == null ? null : (fraction! * 100).floor();
}

class ModelStorageException implements Exception {
  const ModelStorageException(this.message, [this.cause]);

  final String message;
  final Object? cause;

  @override
  String toString() => 'ModelStorageException: $message';
}

/// Downloads a large LiteRT-LM model into app-private Documents storage.
///
/// A `.partial` file is used until verification succeeds, so inference never
/// opens an incomplete multi-gigabyte model. HTTP range requests are used when
/// the CDN supports them.
class ModelDownloadService {
  ModelDownloadService({Dio? dio}) : _dio = dio ?? Dio();

  final Dio _dio;
  CancelToken? _activeCancellation;

  Future<String> modelPath(LocalAiConfig config) async {
    _validateFilename(config.modelFilename);
    final documents = await getApplicationDocumentsDirectory();
    final modelsDirectory = Directory(
      p.join(documents.path, 'Agentie', 'models'),
    );
    await modelsDirectory.create(recursive: true);
    return p.join(modelsDirectory.path, config.modelFilename);
  }

  Future<bool> isModelReady(LocalAiConfig config) async {
    final path = await modelPath(config);
    return _isValidModelFile(File(path), config);
  }

  Stream<ModelDownloadProgress> ensureModel(LocalAiConfig config) {
    final controller = StreamController<ModelDownloadProgress>();
    unawaited(_runDownload(config, controller));
    return controller.stream;
  }

  void cancel() => _activeCancellation?.cancel('Cancelled by user');

  Future<void> _runDownload(
    LocalAiConfig config,
    StreamController<ModelDownloadProgress> controller,
  ) async {
    final cancellation = CancelToken();
    _activeCancellation?.cancel('Superseded by another model download');
    _activeCancellation = cancellation;

    RandomAccessFile? output;
    try {
      config.validate();
      final path = await modelPath(config);
      final target = File(path);
      controller.add(
        ModelDownloadProgress(
          status: ModelDownloadStatus.checking,
          downloadedBytes: await target.exists() ? await target.length() : 0,
          totalBytes: config.expectedModelBytes,
          localPath: path,
        ),
      );

      if (await _isValidModelFile(target, config)) {
        controller.add(
          ModelDownloadProgress(
            status: ModelDownloadStatus.ready,
            downloadedBytes: await target.length(),
            totalBytes: config.expectedModelBytes ?? await target.length(),
            localPath: path,
          ),
        );
        return;
      }

      if (await target.exists()) {
        await target.delete();
      }

      final partial = File('$path.partial');
      await partial.parent.create(recursive: true);
      if (await _isValidModelFile(partial, config)) {
        await partial.rename(path);
        final size = await target.length();
        controller.add(
          ModelDownloadProgress(
            status: ModelDownloadStatus.ready,
            downloadedBytes: size,
            totalBytes: config.expectedModelBytes ?? size,
            localPath: path,
          ),
        );
        return;
      }
      var downloaded = await partial.exists() ? await partial.length() : 0;
      final headers = <String, Object>{
        if (config.downloadBearerToken case final token?)
          HttpHeaders.authorizationHeader: 'Bearer $token',
        if (downloaded > 0) HttpHeaders.rangeHeader: 'bytes=$downloaded-',
      };

      final response = await _dio.get<ResponseBody>(
        config.modelUri.toString(),
        cancelToken: cancellation,
        options: Options(
          headers: headers,
          responseType: ResponseType.stream,
          followRedirects: true,
          receiveTimeout: const Duration(minutes: 5),
          validateStatus: (status) => status == 200 || status == 206,
        ),
      );

      final resumed = response.statusCode == HttpStatus.partialContent;
      if (downloaded > 0 && !resumed) {
        downloaded = 0;
      }
      output = await partial.open(
        mode: resumed ? FileMode.append : FileMode.write,
      );

      final contentRange = response.headers.value('content-range');
      final rangeTotal = contentRange == null
          ? null
          : int.tryParse(contentRange.split('/').last);
      final responseLength = int.tryParse(
        response.headers.value(HttpHeaders.contentLengthHeader) ?? '',
      );
      final total =
          config.expectedModelBytes ??
          rangeTotal ??
          (responseLength == null ? null : downloaded + responseLength);

      controller.add(
        ModelDownloadProgress(
          status: ModelDownloadStatus.downloading,
          downloadedBytes: downloaded,
          totalBytes: total,
          localPath: path,
        ),
      );

      await for (final chunk in response.data!.stream) {
        if (cancellation.isCancelled) {
          throw DioException(
            requestOptions: response.requestOptions,
            type: DioExceptionType.cancel,
            error: 'Cancelled by user',
          );
        }
        await output.writeFrom(chunk);
        downloaded += chunk.length;
        controller.add(
          ModelDownloadProgress(
            status: ModelDownloadStatus.downloading,
            downloadedBytes: downloaded,
            totalBytes: total,
            localPath: path,
          ),
        );
      }
      await output.flush();
      await output.close();
      output = null;

      controller.add(
        ModelDownloadProgress(
          status: ModelDownloadStatus.verifying,
          downloadedBytes: downloaded,
          totalBytes: total,
          localPath: path,
        ),
      );

      if (!await _isValidModelFile(partial, config)) {
        throw const ModelStorageException(
          'Downloaded model failed size or SHA-256 verification.',
        );
      }
      await partial.rename(path);
      controller.add(
        ModelDownloadProgress(
          status: ModelDownloadStatus.ready,
          downloadedBytes: downloaded,
          totalBytes: total ?? downloaded,
          localPath: path,
        ),
      );
    } on DioException catch (error, stackTrace) {
      if (CancelToken.isCancel(error)) {
        controller.add(
          const ModelDownloadProgress(
            status: ModelDownloadStatus.cancelled,
            downloadedBytes: 0,
          ),
        );
      } else {
        controller.addError(_friendlyDownloadError(error), stackTrace);
      }
    } on FileSystemException catch (error, stackTrace) {
      controller.addError(
        ModelStorageException(
          'The device could not store the model. Check free space and retry.',
          error,
        ),
        stackTrace,
      );
    } catch (error, stackTrace) {
      controller.addError(error, stackTrace);
    } finally {
      await output?.close();
      if (identical(_activeCancellation, cancellation)) {
        _activeCancellation = null;
      }
      await controller.close();
    }
  }

  Future<bool> _isValidModelFile(File file, LocalAiConfig config) async {
    if (!await file.exists()) return false;
    final size = await file.length();
    if (size <= 0) return false;
    if (config.expectedModelBytes case final expected?) {
      if (size != expected) return false;
    }
    if (config.expectedSha256 case final expectedHash?) {
      final digest = await sha256.bind(file.openRead()).first;
      if (digest.toString().toLowerCase() != expectedHash.toLowerCase()) {
        return false;
      }
    }
    return true;
  }

  Exception _friendlyDownloadError(DioException error) {
    return switch (error.response?.statusCode) {
      401 || 403 => const ModelStorageException(
        'Model access was denied. Check the download token or model licence.',
      ),
      404 => const ModelStorageException(
        'The configured model URL was not found.',
      ),
      429 => const ModelStorageException(
        'The model host rate-limited this device. Please retry shortly.',
      ),
      _ => ModelStorageException(
        'The model download failed. The partial file was kept for resume.',
        error,
      ),
    };
  }

  void _validateFilename(String filename) {
    if (filename.isEmpty ||
        filename != p.basename(filename) ||
        filename.contains('/') ||
        filename.contains(r'\')) {
      throw ArgumentError.value(filename, 'filename', 'Unsafe model filename.');
    }
  }
}
