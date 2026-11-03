import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'i18n.dart';

import 'app.dart';
import 'iroh_ffi_transport.dart';
import 'native_remote_controller.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await uiLocale.initialize(await getApplicationSupportDirectory());
  final controller = NativeRemoteController(
    credentials: const SecureRemoteCredentialStore(),
    transport: IrohFfiTransport(),
  );
  await controller.initialize();
  runApp(JoiMobileApp(controller: controller));
}
