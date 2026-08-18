import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'bundled_runtime_controller.dart';
import 'local_web_bridge.dart';

class AgentieInstalledApp extends StatelessWidget {
  const AgentieInstalledApp({
    required this.webServer,
    required this.windowsEnvironment,
    required this.startupError,
    super.key,
  });

  final InAppLocalhostServer webServer;
  final WebViewEnvironment? windowsEnvironment;
  final String? startupError;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Agentie',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xFF09090A),
        colorScheme: const ColorScheme.dark(primary: Color(0xFF10A8FF)),
      ),
      home: AgentieShell(
        webServer: webServer,
        windowsEnvironment: windowsEnvironment,
        startupError: startupError,
      ),
    );
  }
}

class AgentieShell extends ConsumerStatefulWidget {
  const AgentieShell({
    required this.webServer,
    required this.windowsEnvironment,
    required this.startupError,
    super.key,
  });

  final InAppLocalhostServer webServer;
  final WebViewEnvironment? windowsEnvironment;
  final String? startupError;

  @override
  ConsumerState<AgentieShell> createState() => _AgentieShellState();
}

class _AgentieShellState extends ConsumerState<AgentieShell> {
  @override
  void initState() {
    super.initState();
    if (widget.startupError == null) {
      Future<void>.microtask(
        () => ref.read(bundledRuntimeControllerProvider.notifier).prepare(),
      );
    }
  }

  @override
  void dispose() {
    unawaited(widget.webServer.close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final runtime = ref.watch(bundledRuntimeControllerProvider);
    final blockingError = widget.startupError;
    return Scaffold(
      body: Stack(
        fit: StackFit.expand,
        children: [
          if (blockingError == null)
            InAppWebView(
              webViewEnvironment: widget.windowsEnvironment,
              initialUrlRequest: URLRequest(
                url: WebUri('http://127.0.0.1:8787/index.html'),
              ),
              initialSettings: InAppWebViewSettings(
                javaScriptEnabled: true,
                transparentBackground: false,
                supportZoom: false,
                useShouldOverrideUrlLoading: true,
              ),
              onWebViewCreated: (controller) {
                LocalWebBridge(ref: ref, webView: controller).install();
              },
            ),
          if (blockingError != null)
            _PreparationPanel(
              title: 'Agentie could not start',
              detail: blockingError,
              isError: true,
            )
          else if (!runtime.mayShowInterface)
            _PreparationPanel(
              title: _title(runtime),
              detail: runtime.error ?? _detail(runtime),
              progress: runtime.progress,
              isError: runtime.phase == BundledRuntimePhase.error,
              onRetry: runtime.phase == BundledRuntimePhase.error
                  ? () => ref
                        .read(bundledRuntimeControllerProvider.notifier)
                        .prepare()
                  : null,
            ),
        ],
      ),
    );
  }

  String _title(BundledRuntimeState runtime) => switch (runtime.phase) {
    BundledRuntimePhase.checking => 'Preparing local AI',
    BundledRuntimePhase.preparing => 'Installing the bundled model',
    BundledRuntimePhase.loading => 'Starting Agentie’s local brain',
    BundledRuntimePhase.error => 'Local AI could not start',
    _ => 'Preparing Agentie',
  };

  String _detail(BundledRuntimeState runtime) => switch (runtime.phase) {
    BundledRuntimePhase.checking => 'Verifying the private on-device model…',
    BundledRuntimePhase.preparing =>
      'This happens locally and does not download anything.',
    BundledRuntimePhase.loading => 'Selecting the fastest available hardware…',
    _ => 'Almost ready…',
  };
}

class _PreparationPanel extends StatelessWidget {
  const _PreparationPanel({
    required this.title,
    required this.detail,
    this.progress,
    this.isError = false,
    this.onRetry,
  });

  final String title;
  final String detail;
  final int? progress;
  final bool isError;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: const Color(0xFF09090A),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 30,
                  height: 30,
                  decoration: BoxDecoration(
                    color: isError
                        ? const Color(0xFFEF4444)
                        : const Color(0xFF10A8FF),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(height: 20),
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 8),
                Text(
                  detail,
                  style: const TextStyle(
                    color: Color(0xFFA1A1AA),
                    fontSize: 13,
                    height: 1.45,
                  ),
                ),
                if (!isError) ...[
                  const SizedBox(height: 20),
                  LinearProgressIndicator(
                    value: progress == null ? null : progress! / 100,
                    minHeight: 3,
                    backgroundColor: const Color(0xFF242429),
                    color: const Color(0xFF10A8FF),
                    borderRadius: BorderRadius.circular(99),
                  ),
                ],
                if (onRetry != null) ...[
                  const SizedBox(height: 20),
                  OutlinedButton(
                    onPressed: onRetry,
                    child: const Text('Retry'),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
