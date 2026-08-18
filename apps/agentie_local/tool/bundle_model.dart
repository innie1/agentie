import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

Future<void> main(List<String> arguments) async {
  final options = _options(arguments);
  final sourceValue = options['source'];
  final target = options['target'];
  final variant = options['variant'] ?? (target == 'desktop' ? 'E4B' : 'E2B');
  if (sourceValue == null || !{'desktop', 'mobile'}.contains(target)) {
    stderr.writeln(
      'Usage: dart run tool/bundle_model.dart '
      '--source <model.litertlm> --target <desktop|mobile> [--variant E4B]',
    );
    exitCode = 64;
    return;
  }

  final source = File(sourceValue);
  if (!await source.exists() ||
      !source.path.toLowerCase().endsWith('.litertlm')) {
    throw ArgumentError('Source must be an existing .litertlm model.');
  }

  final destination = File('assets/models/agentie-local-model.litertlm');
  await destination.parent.create(recursive: true);
  stdout.writeln('Staging the $variant model for $target…');
  await source.copy(destination.path);

  final size = await destination.length();
  stdout.writeln('Calculating SHA-256 for $size bytes…');
  final digest = await sha256.bind(destination.openRead()).first;
  final manifest = <String, dynamic>{
    'schema': 1,
    'bundled': true,
    'target': target,
    'model': {
      'filename': 'agentie-local-model.litertlm',
      'variant': variant,
      'expectedBytes': size,
      'sha256': digest.toString(),
    },
  };
  const encoder = JsonEncoder.withIndent('  ');
  await File(
    'assets/models/model-manifest.json',
  ).writeAsString('${encoder.convert(manifest)}\n');
  stdout.writeln('Bundled model ready. No runtime model download is required.');
}

Map<String, String> _options(List<String> arguments) {
  final result = <String, String>{};
  for (var index = 0; index < arguments.length - 1; index++) {
    final key = arguments[index];
    if (!key.startsWith('--')) continue;
    result[key.substring(2)] = arguments[++index];
  }
  return result;
}
