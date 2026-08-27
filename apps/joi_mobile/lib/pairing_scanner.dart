import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class PairingScannerPage extends StatefulWidget {
  const PairingScannerPage({super.key});

  @override
  State<PairingScannerPage> createState() => _PairingScannerPageState();
}

class _PairingScannerPageState extends State<PairingScannerPage> {
  final _scanner = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
  );
  bool _accepted = false;

  @override
  void dispose() {
    _scanner.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('扫描 Joi 二维码')),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(controller: _scanner, onDetect: _onDetect),
          Center(
            child: Container(
              width: 250,
              height: 250,
              decoration: BoxDecoration(
                border: Border.all(color: const Color(0xff79c99e), width: 3),
                borderRadius: BorderRadius.circular(24),
              ),
            ),
          ),
          const Align(
            alignment: Alignment.bottomCenter,
            child: SafeArea(
              child: Padding(
                padding: EdgeInsets.all(24),
                child: Text('二维码只在桌面 Joi 中生成，10 分钟内有效。'),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_accepted) return;
    final value = capture.barcodes.firstOrNull?.rawValue;
    if (value == null || !value.startsWith('joi://pair?')) return;
    _accepted = true;
    await _scanner.stop();
    if (mounted) Navigator.pop(context, value);
  }
}
