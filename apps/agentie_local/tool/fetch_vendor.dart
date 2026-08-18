import 'dart:io';

const files = <String, String>{
  'https://cdn.tailwindcss.com?plugins=forms,container-queries':
      'assets/web/vendor/tailwindcss.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2':
      'assets/web/vendor/supabase.js',
  'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js':
      'assets/web/vendor/pdf-lib.min.js',
};

Future<void> main() async {
  final client = HttpClient();
  client.userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      'Chrome/125.0 Safari/537.36';
  try {
    for (final entry in files.entries) {
      final request = await client.getUrl(Uri.parse(entry.key));
      final response = await request.close();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw HttpException(
          'Vendor download failed (${response.statusCode}): ${entry.key}',
        );
      }
      final target = File(entry.value);
      await target.parent.create(recursive: true);
      final sink = target.openWrite();
      await response.pipe(sink);
      stdout.writeln('${target.path}: ${await target.length()} bytes');
    }
    await _downloadMaterialSymbols(client);
  } finally {
    client.close(force: true);
  }
}

Future<void> _downloadMaterialSymbols(HttpClient client) async {
  final cssRequest = await client.getUrl(
    Uri.parse(
      'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:'
      'opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200',
    ),
  );
  final cssResponse = await cssRequest.close();
  final css = await cssResponse
      .transform(const SystemEncoding().decoder)
      .join();
  final match = RegExp(r'url\((https:[^)]+)\)').firstMatch(css);
  if (match == null) throw const FormatException('Material font URL missing.');

  final fontRequest = await client.getUrl(Uri.parse(match.group(1)!));
  final fontResponse = await fontRequest.close();
  final font = File('assets/web/vendor/material-symbols.woff2');
  final sink = font.openWrite();
  await fontResponse.pipe(sink);

  final localCss = css.replaceAll(
    match.group(1)!,
    '/vendor/material-symbols.woff2',
  );
  await File('assets/web/vendor/material-symbols.css').writeAsString(localCss);
  stdout.writeln('${font.path}: ${await font.length()} bytes');
}
