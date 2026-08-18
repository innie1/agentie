import 'package:agentie_local/src/bundled_runtime_controller.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('the installed interface remains blocked until local AI is ready', () {
    const checking = BundledRuntimeState();
    const ready = BundledRuntimeState(phase: BundledRuntimePhase.ready);

    expect(checking.mayShowInterface, isFalse);
    expect(ready.isReady, isTrue);
    expect(ready.mayShowInterface, isTrue);
  });

  test('modelless development never claims that local AI is ready', () {
    const development = BundledRuntimeState(
      phase: BundledRuntimePhase.development,
    );

    expect(development.mayShowInterface, isTrue);
    expect(development.isReady, isFalse);
  });
}
