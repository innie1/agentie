import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'src/agentie_shell.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  final webServer = InAppLocalhostServer(
    documentRoot: 'assets/web',
    port: 8787,
  );
  WebViewEnvironment? windowsEnvironment;
  String? startupError;

  try {
    await webServer.start();
    if (!kIsWeb && Platform.isWindows) {
      final webViewVersion = await WebViewEnvironment.getAvailableVersion();
      if (webViewVersion == null) {
        throw StateError(
          'Microsoft Edge WebView2 is required to display Agentie.',
        );
      }
      final support = await getApplicationSupportDirectory();
      windowsEnvironment = await WebViewEnvironment.create(
        settings: WebViewEnvironmentSettings(
          userDataFolder: p.join(support.path, 'webview'),
        ),
      );
    }
    if (!kIsWeb && Platform.isAndroid) {
      await InAppWebViewController.setWebContentsDebuggingEnabled(kDebugMode);
    }
  } catch (error) {
    startupError = error.toString();
  }

  runApp(
    ProviderScope(
      child: AgentieInstalledApp(
        webServer: webServer,
        windowsEnvironment: windowsEnvironment,
        startupError: startupError,
      ),
    ),
  );
}
