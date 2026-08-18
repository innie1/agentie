import 'dart:io';
import 'dart:typed_data';

import 'package:path/path.dart' as p;
import 'package:printing/printing.dart';

enum LocalAttachmentKind { image, scannedDocument, audio }

/// A multimodal attachment can be supplied by path or directly as bytes.
class LocalAiAttachment {
  const LocalAiAttachment({
    required this.kind,
    this.path,
    this.bytes,
    this.filename,
  }) : assert(path != null || bytes != null);

  final LocalAttachmentKind kind;
  final String? path;
  final Uint8List? bytes;
  final String? filename;

  factory LocalAiAttachment.imagePath(String path) => LocalAiAttachment(
    kind: LocalAttachmentKind.image,
    path: path,
    filename: p.basename(path),
  );

  factory LocalAiAttachment.audioPath(String path) => LocalAiAttachment(
    kind: LocalAttachmentKind.audio,
    path: path,
    filename: p.basename(path),
  );

  factory LocalAiAttachment.documentPath(String path) => LocalAiAttachment(
    kind: LocalAttachmentKind.scannedDocument,
    path: path,
    filename: p.basename(path),
  );
}

class ResolvedMultimodalInput {
  const ResolvedMultimodalInput({required this.images, this.audio});

  final List<Uint8List> images;
  final Uint8List? audio;
}

class AttachmentException implements Exception {
  const AttachmentException(this.message);

  final String message;

  @override
  String toString() => 'AttachmentException: $message';
}

/// Converts image/PDF/audio attachments to the byte payloads expected by Gemma.
class LocalAttachmentResolver {
  const LocalAttachmentResolver({this.maxImages = 4, this.maxPdfPages = 4});

  final int maxImages;
  final int maxPdfPages;

  Future<ResolvedMultimodalInput> resolve(
    List<LocalAiAttachment> attachments,
  ) async {
    final images = <Uint8List>[];
    Uint8List? audio;

    for (final attachment in attachments) {
      final bytes = await _read(attachment);
      switch (attachment.kind) {
        case LocalAttachmentKind.image:
          _validateImage(bytes, attachment.filename ?? attachment.path);
          images.add(bytes);
          break;
        case LocalAttachmentKind.scannedDocument:
          final extension = p
              .extension(attachment.filename ?? attachment.path ?? '')
              .toLowerCase();
          if (extension == '.pdf') {
            var pagesAdded = 0;
            await for (final page in Printing.raster(bytes, dpi: 144)) {
              images.add(await page.toPng());
              pagesAdded++;
              if (images.length >= maxImages || pagesAdded >= maxPdfPages) {
                break;
              }
            }
          } else {
            _validateImage(bytes, attachment.filename ?? attachment.path);
            images.add(bytes);
          }
          break;
        case LocalAttachmentKind.audio:
          if (audio != null) {
            throw const AttachmentException(
              'Only one audio attachment is supported per message.',
            );
          }
          _validateWav(bytes);
          audio = bytes;
          break;
      }

      if (images.length > maxImages) {
        throw AttachmentException(
          'This model is configured for at most $maxImages images/pages.',
        );
      }
    }
    return ResolvedMultimodalInput(images: images, audio: audio);
  }

  Future<Uint8List> _read(LocalAiAttachment attachment) async {
    if (attachment.bytes case final bytes?) return bytes;
    final path = attachment.path;
    if (path == null || path.isEmpty) {
      throw const AttachmentException('Attachment has no readable data.');
    }
    final file = File(path);
    if (!await file.exists()) {
      throw AttachmentException('Attachment does not exist: $path');
    }
    try {
      return await file.readAsBytes();
    } on FileSystemException {
      throw AttachmentException('Attachment could not be read: $path');
    }
  }

  void _validateImage(Uint8List bytes, String? name) {
    if (bytes.length < 12) {
      throw AttachmentException(
        'Image is empty or invalid: ${name ?? 'image'}',
      );
    }
  }

  void _validateWav(Uint8List bytes) {
    if (bytes.length < 44 ||
        String.fromCharCodes(bytes.sublist(0, 4)) != 'RIFF' ||
        String.fromCharCodes(bytes.sublist(8, 12)) != 'WAVE') {
      throw const AttachmentException(
        'Gemma audio input requires a valid WAV recording. Convert MP3/M4A '
        'to WAV before inference.',
      );
    }
  }
}
