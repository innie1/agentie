import 'dart:io';

const filenames = <String>[
  'index.html',
  'style.css',
  'config.js',
  'app.js',
  'plugin-ui-patch.js',
  'response-format.js',
  'agentie-local-bridge.js',
];

Future<void> main() async {
  final target = Directory('assets/web');
  await target.create(recursive: true);
  for (final filename in filenames) {
    final source = File('../../$filename');
    if (!await source.exists()) {
      throw FileSystemException('Missing web asset', source.path);
    }
    await source.copy('${target.path}/$filename');
  }

  final index = File('${target.path}/index.html');
  var html = await index.readAsString();
  html = html
      .replaceAll(
        'https://cdn.tailwindcss.com?plugins=forms,container-queries',
        '/vendor/tailwindcss.js',
      )
      .replaceAll(
        'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
        '/vendor/supabase.js',
      )
      .replaceAll(
        'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
        '/vendor/pdf-lib.min.js',
      )
      .replaceAll(
        '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>',
        '',
      )
      .replaceAll(
        '<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet"/>',
        '<link href="/vendor/material-symbols.css" rel="stylesheet"/>',
      );
  await index.writeAsString(html);
  stdout.writeln('Agentie web interface synchronized for offline packaging.');
}
