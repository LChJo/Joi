import 'dart:async';
import 'package:flutter_test/flutter_test.dart';
import 'package:joi_mobile/i18n.dart';
import 'package:intl/date_symbol_data_local.dart';

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  TestWidgetsFlutterBinding.ensureInitialized();
  await initializeDateFormatting();
  setUp(() {
    uiLocale.setForTest('zh-CN');
  });
  await testMain();
}
