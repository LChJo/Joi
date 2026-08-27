import 'package:flutter/material.dart';

import 'app.dart';
import 'iroh_ffi_transport.dart';
import 'native_remote_controller.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = NativeRemoteController(
    credentials: const SecureRemoteCredentialStore(),
    transport: IrohFfiTransport(),
  );
  await controller.initialize();
  runApp(JoiMobileApp(controller: controller));
}
