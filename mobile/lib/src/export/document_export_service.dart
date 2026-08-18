import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';

enum ExportFormat { pdf, text, markdown, docx }

class ExportedDocument {
  const ExportedDocument({
    required this.path,
    required this.filename,
    required this.mimeType,
    required this.sizeBytes,
  });

  final String path;
  final String filename;
  final String mimeType;
  final int sizeBytes;
}

class DocumentExportException implements Exception {
  const DocumentExportException(this.message, [this.cause]);

  final String message;
  final Object? cause;

  @override
  String toString() => 'DocumentExportException: $message';
}

typedef ExportFontLoader = Future<ByteData> Function();

/// Writes generated Markdown into app-private Documents/Agentie/exports.
class DocumentExportService {
  const DocumentExportService({this.fontLoader});

  /// Supply a bundled Noto Sans TTF loader for complete Unicode PDF output.
  /// Built-in Helvetica is used when this is null.
  final ExportFontLoader? fontLoader;

  Future<ExportedDocument> export({
    required String basename,
    required String markdown,
    required ExportFormat format,
    String? title,
  }) async {
    if (markdown.trim().isEmpty) {
      throw const DocumentExportException('There is no content to export.');
    }
    return switch (format) {
      ExportFormat.pdf => exportPdf(
        basename: basename,
        markdown: markdown,
        title: title,
      ),
      ExportFormat.text => exportText(
        basename: basename,
        text: _plainText(markdown),
      ),
      ExportFormat.markdown => exportMarkdown(
        basename: basename,
        markdown: markdown,
      ),
      ExportFormat.docx => exportDocx(
        basename: basename,
        markdown: markdown,
        title: title,
      ),
    };
  }

  Future<ExportedDocument> exportPdf({
    required String basename,
    required String markdown,
    String? title,
  }) async {
    try {
      final document = pw.Document(
        title: title ?? _safeBasename(basename),
        creator: 'Agentie local Gemma brain',
      );
      final font = fontLoader == null
          ? pw.Font.helvetica()
          : pw.Font.ttf(await fontLoader!());
      final bold = fontLoader == null ? pw.Font.helveticaBold() : font;
      final theme = pw.ThemeData.withFont(base: font, bold: bold);
      final blocks = _pdfBlocks(markdown);
      document.addPage(
        pw.MultiPage(
          pageFormat: PdfPageFormat.a4,
          margin: const pw.EdgeInsets.all(42),
          theme: theme,
          header: title == null
              ? null
              : (context) => pw.Padding(
                  padding: const pw.EdgeInsets.only(bottom: 12),
                  child: pw.Text(
                    title,
                    style: pw.TextStyle(font: bold, fontSize: 10),
                  ),
                ),
          footer: (context) => pw.Align(
            alignment: pw.Alignment.centerRight,
            child: pw.Text(
              '${context.pageNumber} / ${context.pagesCount}',
              style: const pw.TextStyle(fontSize: 9, color: PdfColors.grey600),
            ),
          ),
          build: (_) => blocks,
        ),
      );
      final bytes = await document.save();
      return _write(
        basename: basename,
        extension: 'pdf',
        bytes: bytes,
        mimeType: 'application/pdf',
      );
    } catch (error) {
      throw DocumentExportException('PDF creation failed.', error);
    }
  }

  Future<ExportedDocument> exportText({
    required String basename,
    required String text,
  }) => _write(
    basename: basename,
    extension: 'txt',
    bytes: Uint8List.fromList(utf8.encode(text)),
    mimeType: 'text/plain',
  );

  Future<ExportedDocument> exportMarkdown({
    required String basename,
    required String markdown,
  }) => _write(
    basename: basename,
    extension: 'md',
    bytes: Uint8List.fromList(utf8.encode(markdown)),
    mimeType: 'text/markdown',
  );

  Future<ExportedDocument> exportDocx({
    required String basename,
    required String markdown,
    String? title,
  }) async {
    try {
      final archive = Archive();
      archive.addFile(ArchiveFile.string('[Content_Types].xml', _contentTypes));
      archive.addFile(ArchiveFile.string('_rels/.rels', _packageRelationships));
      archive.addFile(
        ArchiveFile.string('docProps/core.xml', _coreProperties(title)),
      );
      archive.addFile(ArchiveFile.string('docProps/app.xml', _appProperties));
      archive.addFile(
        ArchiveFile.string(
          'word/_rels/document.xml.rels',
          _documentRelationships,
        ),
      );
      archive.addFile(ArchiveFile.string('word/styles.xml', _wordStyles));
      archive.addFile(
        ArchiveFile.string('word/document.xml', _wordDocument(markdown, title)),
      );
      final bytes = ZipEncoder().encodeBytes(archive);
      return _write(
        basename: basename,
        extension: 'docx',
        bytes: bytes,
        mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
    } catch (error) {
      throw DocumentExportException('DOCX creation failed.', error);
    }
  }

  Future<void> previewPdf(String path) async {
    final file = File(path);
    if (!await file.exists() || p.extension(path).toLowerCase() != '.pdf') {
      throw const DocumentExportException('PDF file does not exist.');
    }
    final bytes = await file.readAsBytes();
    await Printing.layoutPdf(onLayout: (_) async => bytes);
  }

  Future<ExportedDocument> _write({
    required String basename,
    required String extension,
    required List<int> bytes,
    required String mimeType,
  }) async {
    try {
      final documents = await getApplicationDocumentsDirectory();
      final directory = Directory(p.join(documents.path, 'Agentie', 'exports'));
      await directory.create(recursive: true);
      final filename = '${_safeBasename(basename)}.$extension';
      final file = File(p.join(directory.path, filename));
      await file.writeAsBytes(bytes, flush: true);
      return ExportedDocument(
        path: file.path,
        filename: filename,
        mimeType: mimeType,
        sizeBytes: await file.length(),
      );
    } on FileSystemException catch (error) {
      throw DocumentExportException(
        'The exported file could not be saved. Check device storage.',
        error,
      );
    }
  }

  List<pw.Widget> _pdfBlocks(String markdown) {
    final widgets = <pw.Widget>[];
    for (final rawLine in markdown.replaceAll('\r\n', '\n').split('\n')) {
      final line = rawLine.trimRight();
      if (line.trim().isEmpty) {
        widgets.add(pw.SizedBox(height: 7));
      } else if (line.startsWith('# ')) {
        widgets.add(pw.Header(level: 0, text: _plainText(line.substring(2))));
      } else if (line.startsWith('## ')) {
        widgets.add(pw.Header(level: 1, text: _plainText(line.substring(3))));
      } else if (line.startsWith('### ')) {
        widgets.add(pw.Header(level: 2, text: _plainText(line.substring(4))));
      } else if (RegExp(r'^[-*]\s+').hasMatch(line)) {
        widgets.add(
          pw.Bullet(
            text: _plainText(line.replaceFirst(RegExp(r'^[-*]\s+'), '')),
          ),
        );
      } else {
        widgets.add(
          pw.Padding(
            padding: const pw.EdgeInsets.only(bottom: 5),
            child: pw.Text(
              _plainText(line),
              style: const pw.TextStyle(fontSize: 11, lineSpacing: 3),
            ),
          ),
        );
      }
    }
    return widgets;
  }

  String _wordDocument(String markdown, String? title) {
    final paragraphs = <String>[
      if (title != null && title.trim().isNotEmpty)
        _wordParagraph(title.trim(), style: 'Title'),
      for (final raw in markdown.replaceAll('\r\n', '\n').split('\n'))
        _wordLine(raw),
    ].join();
    return '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>$paragraphs<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>''';
  }

  String _wordLine(String line) {
    final trimmed = line.trimRight();
    if (trimmed.isEmpty) return '<w:p/>';
    if (trimmed.startsWith('# ')) {
      return _wordParagraph(trimmed.substring(2), style: 'Heading1');
    }
    if (trimmed.startsWith('## ')) {
      return _wordParagraph(trimmed.substring(3), style: 'Heading2');
    }
    if (trimmed.startsWith('### ')) {
      return _wordParagraph(trimmed.substring(4), style: 'Heading3');
    }
    if (RegExp(r'^[-*]\s+').hasMatch(trimmed)) {
      return _wordParagraph(
        '• ${trimmed.replaceFirst(RegExp(r'^[-*]\s+'), '')}',
      );
    }
    return _wordParagraph(trimmed);
  }

  String _wordParagraph(String text, {String? style}) =>
      '<w:p>${style == null ? '' : '<w:pPr><w:pStyle w:val="$style"/></w:pPr>'}'
      '<w:r><w:t xml:space="preserve">${_xml(_plainText(text))}</w:t></w:r></w:p>';

  String _safeBasename(String value) {
    final safe = value
        .trim()
        .replaceAll(RegExp(r'[<>:"/\\|?*\x00-\x1F]'), '_')
        .replaceAll(RegExp(r'\s+'), ' ')
        .replaceAll(RegExp(r'[. ]+$'), '');
    if (safe.isEmpty) return 'Agentie document';
    return safe.length <= 100 ? safe : safe.substring(0, 100);
  }

  String _plainText(String markdown) => markdown
      .replaceAll(RegExp(r'!\[([^\]]*)\]\([^)]*\)'), r'$1')
      .replaceAll(RegExp(r'\[([^\]]+)\]\([^)]*\)'), r'$1')
      .replaceAll(RegExp(r'(```|`|\*\*|__|~~)'), '')
      .replaceAll(RegExp(r'^#{1,6}\s+', multiLine: true), '')
      .trimRight();

  String _xml(String value) => value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');

  String _coreProperties(String? title) =>
      '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${_xml(title ?? 'Agentie document')}</dc:title><dc:creator>Agentie</dc:creator><cp:lastModifiedBy>Agentie</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${DateTime.now().toUtc().toIso8601String()}</dcterms:created></cp:coreProperties>''';

  static const _contentTypes =
      '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>''';

  static const _packageRelationships =
      '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>''';

  static const _documentRelationships =
      '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>''';

  static const _appProperties =
      '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Agentie</Application></Properties>''';

  static const _wordStyles =
      '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style></w:styles>''';
}
